import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditDistribution, contentHash, isInside, MAX_ASSET_BYTES, readLibraryFile, validatePublicPresentation } from './distribution-utils.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
function validId(value) { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value); }
function validHash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
async function copyStaging(stage, destination, profile, audience) {
  const root = await realpath(stage);
  const indexBytes = await readLibraryFile(root, ['library', 'index.json']);
  const library = JSON.parse(indexBytes.toString('utf8'));
  if (library.schemaVersion !== 1 || library.target !== profile || !Array.isArray(library.books)) throw new Error('The staging target must match the distribution profile.');
  if ((library.audience ?? 'demo') !== audience) throw new Error('Staging audience does not match the distribution audience.');
  const referenced = new Set(['library/index.json']);
  const books = new Set();
  const audioSizes = {};
  for (const book of library.books) {
    if (!validId(book.id) || !validId(book.revision) || (audience === 'demo' && book.publicDemo !== true)
      || !validHash(book.manifestSha256) || !Number.isSafeInteger(book.manifestBytes) || book.manifestBytes < 1) throw new Error('The staging allowlist is invalid.');
    const prefix = `library/books/${book.id}/${book.revision}`;
    if (book.manifestUrl !== `${prefix}/manifest.json` || books.has(prefix)) throw new Error('Duplicate or invalid book reference.');
    books.add(prefix);
    const bytes = await readLibraryFile(root, book.manifestUrl.split('/'));
    if (bytes.byteLength !== book.manifestBytes || contentHash(bytes) !== book.manifestSha256) throw new Error('Staged manifest hash mismatch.');
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (manifest.id !== book.id || manifest.revision !== book.revision || manifest.schemaVersion !== 1 || manifest.precision !== 'sentence'
      || !Array.isArray(manifest.chunks) || manifest.chunks.length !== manifest.totalChunks || manifest.completedChunks !== manifest.totalChunks) throw new Error('Staged manifest is incomplete.');
    await validatePublicPresentation(manifest);
    referenced.add(book.manifestUrl);
    for (const chunk of manifest.chunks) {
      const extension = chunk.mimeType === 'audio/mp4' ? 'm4a' : chunk.mimeType === 'audio/mpeg' ? 'mp3' : undefined;
      if (!extension || !validHash(chunk.sha256) || chunk.audioUrl !== `${prefix}/media/${chunk.sha256}.${extension}`
        || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > MAX_ASSET_BYTES) throw new Error('Staged audio reference is invalid.');
      const audio = await readLibraryFile(root, chunk.audioUrl.split('/'));
      if (audio.byteLength !== chunk.bytes || contentHash(audio) !== chunk.sha256) throw new Error('Staged audio hash mismatch.');
      referenced.add(chunk.audioUrl);
      audioSizes[chunk.audioUrl] = chunk.bytes;
    }
  }
  // No recursive copy: unexpected files, original sources, jobs and configuration have no route into output.
  for (const path of referenced) {
    const bytes = await readLibraryFile(root, path.split('/'));
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  }
  return audioSizes;
}

/** Postprocess a completed public Vite build. This function never deploys or invokes TTS. */
export async function buildDistribution(options) {
  const profile = options.profile;
  const audience = options.audience ?? 'demo';
  if (!['demo', 'personal'].includes(audience) || audience === 'personal' && (profile !== 'worker' || !options.staging)) throw new Error('Personal distribution requires worker profile and an explicit personal stage.');
  if (!['pages', 'worker'].includes(profile)) throw new Error('Only pages and worker distribution profiles are allowed.');
  const client = resolve(options.client ?? join(repository, 'apps/web/dist', profile, 'client'));
  const output = resolve(options.output ?? (audience === 'personal' ? join(repository, 'dist/personal-worker') : join(repository, 'dist/distribution', profile)));
  if (audience === 'personal' && isInside(repository, output) && !isInside(join(repository, 'dist'), output)) throw new Error('Personal output must use ignored dist or a directory outside the repository.');
  if (isInside(client, output) || isInside(output, client)) throw new Error('Distribution output and client input must be separate.');
  const inputAudit = await auditDistribution(client, { maxFiles: options.maxFiles, audience });
  if (!inputAudit.fileCount) throw new Error('The public client build is empty.');
  const shell = await readFile(join(client, '_shell.html'), 'utf8');
  const expectedBase = profile === 'pages' ? '/ripola/' : '/';
  if (profile === 'pages' && !shell.includes('/ripola/assets/')) throw new Error('Pages build must use the /ripola/ Vite base.');
  if (profile === 'worker' && shell.includes('/ripola/assets/')) throw new Error('Worker build must use the root Vite base.');
  await mkdir(dirname(output), { recursive: true });
  let existing = false;
  try {
    const info = await lstat(output);
    if (!options.replaceExisting || !info.isDirectory() || info.isSymbolicLink()) throw new Error('Distribution output already exists. Choose a new directory; previous builds are preserved.');
    const previous = JSON.parse(await readFile(join(output, 'distribution.json'), 'utf8'));
    if (previous.schemaVersion !== 1 || previous.profile !== profile || previous.localGenerationApi !== false || (previous.audience ?? 'demo') !== audience) throw new Error('Only a previous managed distribution build may be replaced.');
    existing = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = await mkdtemp(join(dirname(output), '.rsvp-distribution-'));
  let backup;
  try {
    for (const name of await readdir(client)) await cp(join(client, name), join(temporary, name), { recursive: true, errorOnExist: true, force: false });
    // Vite's package license collector does not include a vendored source file.
    // Ship the full copyright and MIT permission notice even if minification drops its source comment.
    await writeFile(join(temporary, 'LICENSE.qrcodegen.txt'), await readFile(join(repository, 'apps/web/src/sharing/vendor/LICENSE.qrcodegen.txt')), { flag: 'wx' });
    await writeFile(join(temporary, 'LICENSE.txt'), await readFile(join(repository, 'LICENSE')), { flag: 'wx' });
    // These npm packages omit standalone notices, so Vite emits only SPDX headings.
    // Keep the pinned upstream full texts and the original format release copyrights.
    for (const [name, source] of [
      ['LICENSE.budoux.txt', 'budoux-0.9.3-LICENSE'],
      ['LICENSE.format.txt', 'format-0.2.2-LICENSE'],
      ['NOTICE.format.txt', 'format-0.2.2-NOTICE'],
      ['LICENSE.react-remove-scroll-bar.txt', 'react-remove-scroll-bar-2.3.8-LICENSE'],
    ]) await writeFile(join(temporary, name), await readFile(join(repository, 'docs/licenses/upstream', source)), { flag: 'wx' });
    await writeFile(join(temporary, 'index.html'), shell, { flag: 'wx' });
    const route = profile === 'pages' ? 'demo' : 'books';
    await mkdir(join(temporary, route), { recursive: true });
    await writeFile(join(temporary, route, 'index.html'), shell, { flag: 'wx' });
    // Vite copies the explicit bundled sample subtree for every profile.
    const audioSizes = {};
    for (const file of inputAudit.files.filter(file => /^samples\/audio\/library\/books\/[^/]+\/[^/]+\/media\/[a-f0-9]{64}\.(?:m4a|mp3)$/.test(file.path))) {
      audioSizes[file.path] = file.bytes;
    }
    if (options.staging) Object.assign(audioSizes, await copyStaging(resolve(options.staging), temporary, profile, audience));
    else {
      await mkdir(join(temporary, 'library'), { recursive: true });
      await writeFile(join(temporary, 'library/index.json'), `${JSON.stringify({ schemaVersion: 1, target: profile, audience, createdAt: new Date().toISOString(), books: [] })}\n`, { flag: 'wx' });
    }
    if (profile === 'worker') await writeFile(join(temporary, 'library/audio-sizes.json'), `${JSON.stringify(audioSizes)}\n`, { flag: 'wx' });
    await writeFile(join(temporary, 'distribution.json'), `${JSON.stringify({ schemaVersion: 1, profile, audience, base: expectedBase, generatedAt: new Date().toISOString(), localGenerationApi: false })}\n`, { flag: 'wx' });
    const report = await auditDistribution(temporary, { maxFiles: options.maxFiles, audience });
    if (existing) {
      backup = `${temporary}.previous`;
      await rename(output, backup);
    }
    await rename(temporary, output);
    if (backup) { await rm(backup, { recursive: true, force: true }); backup = undefined; }
    if (profile === 'worker') {
      // A preparation artifact outside the upload root; credentials and account-specific Access setup are omitted.
      await writeFile(`${output}.wrangler.jsonc`, `${JSON.stringify({ name: 'ripola', compatibility_date: '2026-10-06', workers_dev: false,
        assets: { directory: `./${basename(output)}`, not_found_handling: 'none' } }, null, 2)}\n`, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    }
    return { output, profile, audience, fileCount: report.fileCount, totalBytes: report.totalBytes, localGenerationApi: false };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (backup) await rename(backup, output);
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!['--profile', '--audience', '--staging', '--output', '--client', '--max-files'].includes(args[index]) || !args[index + 1] || flags.has(args[index])) throw new Error('Usage: node scripts/build-distribution.mjs --profile pages|worker [--audience demo|personal] [--staging <allowlisted-stage>] [--output <new-directory>] [--max-files 20000]');
    flags.set(args[index], args[index + 1]);
  }
  const profile = flags.get('--profile');
  if (!['pages', 'worker'].includes(profile)) throw new Error('Only pages and worker distribution profiles are allowed.');
  if (!flags.has('--client')) {
    for (const [command, args] of [[process.execPath, ['scripts/prepare-pdf-assets.mjs']], ['pnpm', ['--filter', '@ripola/web', 'build']]]) {
      await new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: repository, env: { ...process.env, VITE_RSVP_PROFILE: profile }, stdio: 'inherit', shell: false });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Public ${profile} build failed.`)));
      });
    }
  }
  const report = await buildDistribution({ profile, audience: flags.get('--audience'), staging: flags.get('--staging'), output: flags.get('--output'), client: flags.get('--client'), replaceExisting: !flags.has('--output'),
    ...(flags.has('--max-files') ? { maxFiles: Number(flags.get('--max-files')) } : {}) });
  console.log(JSON.stringify({ ...report, note: 'Prepared static assets only. Review access controls before deployment; nothing was deployed.' }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Distribution build failed.'); process.exitCode = 1; });
}
