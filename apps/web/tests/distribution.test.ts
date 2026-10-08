import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AudioBookManifest } from '../src/generation/contracts';
import { distributionLoadError, distributionAssetUrl, loadDistributedBook, loadDistributionLibrary, parsePublicLibrary, publicReadingDocument, type PublicLibraryManifest } from '../src/distribution/library.ts';
import type { ReadingDocument } from '../src/reader/model';
import { stageLibrary, validateStageConfig } from '../../../scripts/stage-library.ts';
import { auditDistribution, contentHash, MAX_ASSET_BYTES } from '../../../scripts/distribution-utils.mjs';
import { buildDistribution } from '../../../scripts/build-distribution.mjs';

const ffmpegAvailable = ['ffmpeg', 'ffprobe'].every(command => spawnSync(command, ['-version'], { stdio: 'ignore' }).status === 0);
const bookId = 'book-demo';
const revision = 'b'.repeat(64);
const speechKey = 'a'.repeat(64);
const document: ReadingDocument = {
  id: bookId, contentHash: 'c'.repeat(64), title: '朝の短い散歩', format: 'txt', rawText: '朝の光が窓に届きました。',
  blocks: [{ id: 'block-1', kind: 'paragraph', text: '朝の光が窓に届きました。', ruby: [], runs: [{ start: 0, end: 12, mapping: 'exact', sources: [{ kind: 'text', start: 0, end: 12 }] }] }],
  units: [{ id: 'unit-1', blockId: 'block-1', kind: 'text', start: 0, end: 12, text: '朝の光が窓に届きました。', sources: [{ kind: 'text', start: 0, end: 12 }], mapping: 'exact', ruby: [], characters: 12, cumulativeCharacters: 12, pause: 'sentence' }],
  totalCharacters: 12, versions: { parser: 'test', model: 'test', rules: 'test' }, warnings: ['internal error with a private path'],
};
function wave() {
  const frames = 12_000;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24_000, 24); bytes.writeUInt32LE(48_000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let index = 0; index < frames; index++) bytes.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / 24_000) * 1000), 44 + index * 2);
  return bytes;
}
async function fixture(root: string) {
  const library = join(root, 'original');
  for (const directory of ['books', 'audio', 'cache', 'sources', 'jobs']) await mkdir(join(library, directory), { recursive: true });
  const audio = wave();
  const manifest: AudioBookManifest = {
    schemaVersion: 1, id: bookId, revision, title: document.title, updatedAt: '2026-10-06T00:00:00Z', document,
    options: { provider: 'voicevox', voice: '1', transport: 'direct', readings: [] },
    completedChunks: 1, totalChunks: 1, durationSeconds: .5, precision: 'sentence', warnings: ['private provider diagnostics'],
    chunks: [{ id: 'chunk-1', speechKey, audioUrl: `/api/local-audio/${speechKey}.wav`, mimeType: 'audio/wav', durationSeconds: .5,
      timeline: [{ chunkId: 'chunk-1', blockId: 'block-1', start: 0, end: 12, unitIds: ['unit-1'], startSeconds: 0, endSeconds: .5, precision: 'sentence' }] }],
  };
  await writeFile(join(library, 'books', `${bookId}_${revision}.json`), JSON.stringify(manifest));
  await writeFile(join(library, 'audio', `${speechKey}.wav`), audio);
  await writeFile(join(library, 'cache', `${speechKey}.json`), JSON.stringify({ schemaVersion: 1, status: 'ready', hash: contentHash(audio), durationSeconds: .5 }));
  await writeFile(join(library, 'sources', 'unselected-secret.txt'), 'Unselected source');
  await writeFile(join(library, 'jobs', 'job.json'), JSON.stringify({ private: true }));
  return library;
}
function allowlist(libraryDir: string, target: 'pages' | 'worker' = 'pages') {
  return { target, libraryDir, books: [{ id: bookId, revision, rightsConfirmed: true, publicDemo: true, attribution: '自作サンプル。音声: VOICEVOX。' }] };
}
async function files(root: string, prefix = ''): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) output.push(...await files(root, name)); else output.push(name);
  }
  return output.sort();
}
async function temporary(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'rsvp-distribution-test-'));
  try { await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('allowlist requires book revisions, rights and an explicit Pages demo designation', () => {
  assert.throws(() => validateStageConfig({ target: 'pages', libraryDir: '/test', books: [] }));
  assert.throws(() => validateStageConfig({ ...allowlist('/test'), books: [{ id: '../source', revision, rightsConfirmed: true, publicDemo: true, attribution: 'Author' }] }));
  assert.throws(() => validateStageConfig({ ...allowlist('/test'), books: [{ id: bookId, revision, rightsConfirmed: true, attribution: 'Author' }] }));
  assert.throws(() => validateStageConfig({ ...allowlist('/test'), books: [allowlist('/test').books[0], allowlist('/test').books[0]] }));
});

test('public projection preserves selected text and coordinates but drops unknown and diagnostic metadata', () => {
  const source = { ...document, apiKey: 'never publish', internalPath: '/private/source', options: { credential: 'never' } };
  const projected = publicReadingDocument(source);
  assert.equal(projected.rawText, document.rawText);
  assert.deepEqual(projected.blocks, document.blocks);
  assert.equal(JSON.stringify(projected).includes('never'), false);
  assert.deepEqual(projected.warnings, []);
});

test('asset URLs preserve a Pages base and reject path traversal and external references', () => {
  assert.equal(distributionAssetUrl('library/index.json', '/ripola/', 'https://example.test'), 'https://example.test/ripola/library/index.json');
  for (const path of ['../.env.local', 'library/../sources/key', 'https://other.test/audio', 'library/%2e%2e/key', 'library//audio']) assert.throws(() => distributionAssetUrl(path));
  assert.throws(() => distributionAssetUrl('library/index.json', 'https://user:pass@example.test/'));
});

test('actual upload tree rejects private folders, credentials, local APIs, oversized files and symlinks', async () => temporary(async root => {
  await mkdir(join(root, 'jobs')); await writeFile(join(root, 'jobs/job.json'), '{}');
  await assert.rejects(auditDistribution(root), /Private or server/); await rm(join(root, 'jobs'), { recursive: true });
  await writeFile(join(root, 'app.js'), "fetch('/api/local-generation/config')");
  await assert.rejects(auditDistribution(root), /Local generation/);
  await writeFile(join(root, 'app.js'), `const key='${'AIza' + 'x'.repeat(35)}'`);
  await assert.rejects(auditDistribution(root), /credential/);
  await writeFile(join(root, 'app.js'), 'public app');
  await writeFile(join(root, 'aligner.onnx'), 'not an asset');
  await assert.rejects(auditDistribution(root), /Model\/runtime/); await rm(join(root, 'aligner.onnx'));
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ apiKey: 'configuration is never a public artifact' }));
  await assert.rejects(auditDistribution(root), /Credential configuration/); await rm(join(root, 'manifest.json'));
  await writeFile(join(root, 'large.m4a'), ''); await truncate(join(root, 'large.m4a'), MAX_ASSET_BYTES + 1);
  await assert.rejects(auditDistribution(root), /25 MiB/); await rm(join(root, 'large.m4a'));
  await symlink(join(root, 'app.js'), join(root, 'copy.js')); await assert.rejects(auditDistribution(root), /symlink/); await rm(join(root, 'copy.js'));
  await writeFile(join(root, 'extra.js'), 'public'); await assert.rejects(auditDistribution(root, { maxFiles: 1 }), /count/);
}));

test('AAC staging preserves source audio and publishes only the selected content projection', { skip: !ffmpegAvailable }, async () => temporary(async root => {
  const libraryDir = await fixture(root);
  const before = await readFile(join(libraryDir, 'audio', `${speechKey}.wav`));
  const output = join(root, 'pages-stage');
  const result = await stageLibrary(allowlist(libraryDir), { output });
  assert.equal(result.books, 1); assert.equal(result.fileCount, 3);
  const index = parsePublicLibrary(JSON.parse(await readFile(join(output, 'library/index.json'), 'utf8')));
  const entry = index.books[0];
  const manifestBytes = await readFile(join(output, entry.manifestUrl));
  const manifest = JSON.parse(manifestBytes.toString());
  assert.equal(contentHash(manifestBytes), entry.manifestSha256);
  assert.equal(manifest.chunks[0].mimeType, 'audio/mp4');
  assert.equal(manifest.chunks[0].timeline[0].endSeconds, manifest.chunks[0].durationSeconds);
  assert.equal(manifest.chunks[0].timing.algorithm, 'pcm-normalized-xcorr-v1');
  assert.equal(manifest.chunks[0].timing.verification, 'unverified'); // A short periodic test tone cannot prove offset/drift.
  assert.equal(manifest.chunks[0].alignment.precision, 'sentence');
  assert.equal(manifest.document.rawText, document.rawText);
  assert.equal(manifest.options, undefined); assert.equal(manifest.chunks[0].speechKey, undefined);
  assert.equal(manifestBytes.toString().includes('private provider'), false);
  assert.deepEqual(await readFile(join(libraryDir, 'audio', `${speechKey}.wav`)), before);
  assert.deepEqual((await files(output)).filter(path => !path.startsWith('library/')), []);
  const fetched = await loadDistributedBook(entry, 'https://example.test/ripola/', async () => new Response(manifestBytes) as Response);
  assert.match(fetched.chunks[0].audioUrl, /^https:\/\/example.test\/ripola\/library\//);
  await assert.rejects(loadDistributedBook({ ...entry, manifestSha256: '0'.repeat(64) }, '/', async () => new Response(manifestBytes) as Response), /一致/);
  await assert.rejects(stageLibrary(allowlist(libraryDir), { output }), /already exists/);
}));

test('corrupt cache and an unfinished book fail without touching original data', { skip: !ffmpegAvailable }, async () => temporary(async root => {
  const libraryDir = await fixture(root);
  await writeFile(join(libraryDir, 'cache', `${speechKey}.json`), JSON.stringify({ schemaVersion: 1, status: 'ready', hash: '0'.repeat(64), durationSeconds: .5 }));
  await assert.rejects(stageLibrary(allowlist(libraryDir), { output: join(root, 'bad-stage') }), /content hash/);
  assert.equal((await files(root)).some(path => path.includes('.rsvp-stage')), false);
  const path = join(libraryDir, 'books', `${bookId}_${revision}.json`);
  const manifest = JSON.parse(await readFile(path, 'utf8')); manifest.completedChunks = 0; await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(stageLibrary(allowlist(libraryDir), { output: join(root, 'bad-stage') }), /complete/);
}));

test('public build postprocessing copies only referenced stage artifacts and refuses a private stage for Pages', { skip: !ffmpegAvailable }, async () => temporary(async root => {
  const libraryDir = await fixture(root);
  const stage = join(root, 'stage'); await stageLibrary(allowlist(libraryDir), { output: stage });
  await mkdir(join(stage, 'jobs')); await writeFile(join(stage, 'jobs/private.json'), 'never copy'); await writeFile(join(stage, '.env.local'), 'never copy');
  const client = join(root, 'client'); await mkdir(join(client, 'assets'), { recursive: true });
  await writeFile(join(client, '_shell.html'), '<html><script src="/ripola/assets/reader.js"></script></html>');
  await writeFile(join(client, 'assets/reader.js'), 'console.log("reader")');
  const output = join(root, 'distribution');
  await buildDistribution({ profile: 'pages', client, output, staging: stage });
  const list = await files(output);
  assert.ok(list.includes('index.html')); assert.ok(list.includes('demo/index.html'));
  for (const [name, source] of [
    ['LICENSE.txt', '../../../LICENSE'],
    ['LICENSE.budoux.txt', '../../../docs/licenses/upstream/budoux-0.9.3-LICENSE'],
    ['LICENSE.format.txt', '../../../docs/licenses/upstream/format-0.2.2-LICENSE'],
    ['NOTICE.format.txt', '../../../docs/licenses/upstream/format-0.2.2-NOTICE'],
    ['LICENSE.react-remove-scroll-bar.txt', '../../../docs/licenses/upstream/react-remove-scroll-bar-2.3.8-LICENSE'],
    ['LICENSE.qrcodegen.txt', '../src/sharing/vendor/LICENSE.qrcodegen.txt'],
  ]) {
    assert.deepEqual(await readFile(join(output, name)), await readFile(new URL(source, import.meta.url)));
  }
  assert.equal(list.some(path => /jobs|\.env|sources|cache/.test(path)), false);
  assert.equal(list.filter(path => path.endsWith('.m4a')).length, 1);
  const indexPath = join(stage, 'library/index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8')); index.target = 'worker'; await writeFile(indexPath, JSON.stringify(index));
  await assert.rejects(buildDistribution({ profile: 'pages', client, output: join(root, 'wrong'), staging: stage }), /target/);
  await writeFile(join(client, '_shell.html'), '<html><script src="/assets/reader.js"></script></html>');
  const workerOutput = join(root, 'worker-distribution');
  await buildDistribution({ profile: 'worker', client, output: workerOutput, staging: stage });
  const entry = index.books[0];
  const book = JSON.parse(await readFile(join(stage, entry.manifestUrl), 'utf8'));
  assert.deepEqual(JSON.parse(await readFile(join(workerOutput, 'library/audio-sizes.json'), 'utf8')),
    { [book.chunks[0].audioUrl]: book.chunks[0].bytes });
  assert.equal((await files(workerOutput)).some(path => /jobs|\.env|sources|cache/.test(path)), false);
}));

test('empty public library is valid and failed download gives a readable error', async () => {
  const library: PublicLibraryManifest = { schemaVersion: 1, target: 'pages', createdAt: '2026-10-06T00:00:00Z', books: [] };
  assert.deepEqual(await loadDistributionLibrary('https://example.test/ripola/', async () => Response.json(library)), library);
  await assert.rejects(loadDistributionLibrary('/', async () => new Response('missing', { status: 404 })), /取得/);
});

test('managed output can be rebuilt and a failed audit preserves the previous upload tree', async () => temporary(async root => {
  const client = join(root, 'client'); await mkdir(join(client, 'assets'), { recursive: true });
  await writeFile(join(client, '_shell.html'), '<html><script src="/assets/reader.js"></script></html>');
  await writeFile(join(client, 'assets/reader.js'), 'console.log("first")');
  const output = join(root, 'worker');
  await buildDistribution({ profile: 'worker', client, output });
  await writeFile(join(client, 'assets/reader.js'), 'console.log("second")');
  await buildDistribution({ profile: 'worker', client, output, replaceExisting: true });
  assert.equal(await readFile(join(output, 'assets/reader.js'), 'utf8'), 'console.log("second")');
  assert.ok((await files(output)).includes('books/index.html'));
  const template = JSON.parse(await readFile(`${output}.wrangler.jsonc`, 'utf8'));
  assert.equal(template.workers_dev, false); assert.equal(template.assets.directory, './worker');
  await writeFile(join(client, 'assets/reader.js'), 'const value="GEMINI_API_KEY"');
  await assert.rejects(buildDistribution({ profile: 'worker', client, output, replaceExisting: true }), /Local generation/);
  assert.equal(await readFile(join(output, 'assets/reader.js'), 'utf8'), 'console.log("second")');
}));


test('inspection failures are visible and fetched/internal errors are not reflected', () => {
  assert.match(distributionLoadError(new Error('区切り表示の検査記録が一致しません。')), /検査に失敗/);
  assert.doesNotMatch(distributionLoadError(new Error('private internal path /private/source secret')), /private|secret|source/);
});

test('personal stage is explicitly opt-in, separate from demo, and cannot enter a demo build', {skip: !ffmpegAvailable}, async () => temporary(async root => {
  const libraryDir=await fixture(root);
  const personal={...allowlist(libraryDir,'worker'),audience:'personal' as const,books:[{...allowlist(libraryDir,'worker').books[0],publicDemo:false}]};
  assert.throws(()=>validateStageConfig({...personal,audience:undefined}),/Demo distribution/);
  assert.throws(()=>validateStageConfig({...personal,target:'pages'}),/Personal distribution/);
  const stage=join(root,'personal-stage');await stageLibrary(personal,{output:stage});
  const catalog=JSON.parse(await readFile(join(stage,'library/index.json'),'utf8'));
  assert.equal(catalog.audience,'personal');assert.equal(catalog.books[0].publicDemo,false);
  assert.equal(parsePublicLibrary(catalog).audience,'personal');
  const client=join(root,'client');await mkdir(join(client,'assets'),{recursive:true});
  await writeFile(join(client,'_shell.html'),'<html><script src="/assets/reader.js"></script></html>');
  await writeFile(join(client,'assets/reader.js'),'console.log("reader")');
  await assert.rejects(buildDistribution({profile:'worker',client,output:join(root,'demo'),staging:stage}),/audience/);
  await assert.rejects(buildDistribution({profile:'worker',audience:'personal',client,output:join(root,'missing')}),/explicit personal stage/);
  const output=join(root,'personal-worker');await buildDistribution({profile:'worker',audience:'personal',client,output,staging:stage});
  const report=JSON.parse(await readFile(join(output,'distribution.json'),'utf8'));
  assert.equal(report.audience,'personal');assert.equal(report.localGenerationApi,false);
  const entry=catalog.books[0];const manifestBytes=await readFile(join(output,entry.manifestUrl));
  const fetched=await loadDistributedBook(entry,'https://personal.example/',async()=>new Response(manifestBytes));
  assert.equal(fetched.document.rawText,document.rawText);assert.equal(fetched.presentation?.status,'valid');
  assert.match(fetched.chunks[0].audioUrl,/^https:\/\/personal.example\/library\//);
  assert.equal((await files(output)).some(path=>/jobs|sources|cache|\.env|\.wav$/.test(path)),false);
  await assert.rejects(buildDistribution({profile:'worker',client,output,replaceExisting:true}),/previous managed/);
  const legacy=join(root,'legacy-stage');await mkdir(join(legacy,'library'),{recursive:true});
  await writeFile(join(legacy,'library/index.json'),JSON.stringify({...catalog,audience:undefined}));
  await assert.rejects(buildDistribution({profile:'worker',client,output:join(root,'legacy-demo'),staging:legacy}),/allowlist/);
}));

test('a personal catalog copied into client assets cannot pass the demo build audit', async()=>temporary(async root=>{
  const client=join(root,'client');await mkdir(join(client,'library'),{recursive:true});
  await writeFile(join(client,'_shell.html'),'<html><script src="/assets/reader.js"></script></html>');
  await writeFile(join(client,'library/index.json'),JSON.stringify({schemaVersion:1,target:'worker',audience:'personal',createdAt:'2026-10-07',books:[]}));
  await assert.rejects(buildDistribution({profile:'worker',client,output:join(root,'demo')}),/Personal library/);
}));
