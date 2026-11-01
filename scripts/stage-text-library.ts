import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePublicLibrary, publicReadingDocument, requireTextBook, type PublicAudioBookManifest, type PublicBookEntry, type PublicLibraryManifest } from '../apps/web/src/distribution/library.ts';
import type { ReadingDocument } from '../apps/web/src/reader/model.ts';
import { auditDistribution, contentHash, isInside, MAX_ASSET_BYTES, readLibraryFile } from './distribution-utils.mjs';

export interface TextSelection { id: string; revision: string; documentFile: string; attribution: string; rightsConfirmed: true; updatedAt?: string }
export interface StageTextOptions { output: string; /** Tests may lower the limit; production always uses the 25 MiB asset ceiling. */ maxAssetBytes?: number }

interface SelectedDocument { document: ReadingDocument; updatedAt?: string }
function selectedDocument(value: unknown): SelectedDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Selected text document is invalid.');
  const record = value as Record<string, unknown>;
  if (record.kind === 'text' && record.document) return { document: record.document as ReadingDocument, ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}) };
  return { document: value as ReadingDocument };
}
function requireTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) throw new Error('Text book updatedAt is invalid.');
  return value;
}
function sameJson(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}
/**
 * Copy one asset, allowing several books to reference the same audio URL.
 * An existing path is reused only when its bytes are identical; a different
 * payload at the same path is a collision and stops staging.
 */
export async function writeStagedAsset(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!sameBytes(await readFile(path), bytes)) throw new Error(`The same staged asset path has different bytes: ${path}`, { cause: error });
  }
}

/**
 * Build a personal text-library stage without touching an existing catalog.
 * Every serialized manifest is validated and measured before the temporary
 * directory is created; the destination only appears after the final audit.
 */
export async function stageTextLibrary(config: { target: 'worker'; audience: 'personal'; existing: string; books: TextSelection[] }, output: string, options: Omit<StageTextOptions, 'output'> = {}) {
  if (config.target !== 'worker' || config.audience !== 'personal' || !config.books?.length || config.books.some(b => b.rightsConfirmed !== true || !b.attribution?.trim())) throw new Error('Explicit personal text selection and attribution are required.');
  const maximum = options.maxAssetBytes ?? MAX_ASSET_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Asset byte limit is invalid.');
  const base = await realpath(resolve(config.existing)), destination = resolve(output);
  const repository = resolve(import.meta.dirname, '..');
  if (isInside(repository, destination) && !isInside(join(repository, 'staging-private'), destination)) throw new Error('Personal staging must use staging-private or a directory outside the repository.');
  if (isInside(base, destination) || isInside(destination, base)) throw new Error('Stage must be separate from existing distribution.');
  try { await lstat(destination); throw new Error('Staging output already exists. Choose a new directory; existing artifacts are preserved.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Preserve the entire verified existing catalog. No regeneration of audio or recursive source copying.
  await auditDistribution(base, { audience: 'personal' });
  const previous = parsePublicLibrary(JSON.parse((await readLibraryFile(base, ['library', 'index.json'])).toString('utf8')));
  if (previous.audience !== 'personal' || previous.target !== 'worker') throw new Error('Existing catalog must be personal.');
  const books: PublicBookEntry[] = [];
  const pending = new Map<string, Uint8Array>();
  const reused: string[] = [];
  const add = (path: string, bytes: Uint8Array) => {
    if (pending.has(path)) throw new Error('Duplicate staged artifact path.');
    if (bytes.byteLength > maximum) throw new Error(`Text manifest exceeds the ${Math.floor(maximum / 1024 / 1024)} MiB asset limit: ${path}. Split the chapter/section and restage.`);
    pending.set(path, bytes);
  };
  for (const selected of config.books) {
    const { document, updatedAt: bookUpdatedAt } = selectedDocument(JSON.parse(await readFile(selected.documentFile, 'utf8')));
    const projected = publicReadingDocument(document);
    if (projected.contentHash !== selected.revision) throw new Error('Text revision must match its document hash.');
    const existing = previous.books.find(book => book.id === selected.id && book.revision === selected.revision);
    if (existing) {
      const bytes = await readLibraryFile(base, existing.manifestUrl.split('/'));
      const manifest = JSON.parse(bytes.toString('utf8')) as PublicAudioBookManifest;
      requireTextBook(manifest);
      if (manifest.id !== selected.id || manifest.revision !== selected.revision || manifest.title !== projected.title
        || manifest.attribution !== selected.attribution || !sameJson(manifest.document, projected)
        || (selected.updatedAt !== undefined && selected.updatedAt !== manifest.updatedAt)) {
        throw new Error(`The same id/revision already has different immutable bytes: ${selected.id}/${selected.revision}`);
      }
      reused.push(`${selected.id}/${selected.revision}`);
      continue;
    }
    // Never use the staging clock. Prefer the explicit timestamp or the local
    // text book's fetchedAt; legacy raw documents fall back to their source
    // file mtime so re-running the same allowlist reproduces the same bytes.
    const sourceTimestamp = selected.updatedAt ?? bookUpdatedAt ?? (await stat(selected.documentFile)).mtime.toISOString();
    const updatedAt = requireTimestamp(sourceTimestamp);
    const manifest: PublicAudioBookManifest = {
      schemaVersion: 1, kind: 'text', id: selected.id, revision: selected.revision, title: projected.title,
      document: projected, updatedAt, chunks: [], completedChunks: 0, totalChunks: 0, durationSeconds: 0,
      precision: 'sentence', attribution: selected.attribution, warnings: [],
    };
    requireTextBook(manifest);
    const bytes = new TextEncoder().encode(JSON.stringify(manifest) + '\n');
    const path = `library/books/${manifest.id}/${manifest.revision}/manifest.json`;
    add(path, bytes);
    books.push({ kind: 'text', id: manifest.id, revision: manifest.revision, title: manifest.title, updatedAt: manifest.updatedAt,
      manifestUrl: path, manifestSha256: contentHash(bytes), manifestBytes: bytes.byteLength, totalCharacters: manifest.document.totalCharacters,
      durationSeconds: 0, precision: 'sentence', attribution: manifest.attribution, publicDemo: false });
  }
  const library: PublicLibraryManifest = { ...previous, createdAt: new Date().toISOString(), books: [...previous.books, ...books] };
  parsePublicLibrary(library);
  const indexBytes = new TextEncoder().encode(JSON.stringify(library) + '\n');
  if (indexBytes.byteLength > maximum) throw new Error('Text library index exceeds the asset limit.');
  await mkdir(dirname(destination), { recursive: true });
  const parent = await realpath(dirname(destination));
  const temporary = await mkdtemp(join(parent, '.rsvp-text-stage-'));
  try {
    for (const entry of previous.books) {
      await writeStagedAsset(join(temporary, entry.manifestUrl), await readLibraryFile(base, entry.manifestUrl.split('/')));
      const book = JSON.parse((await readLibraryFile(base, entry.manifestUrl.split('/'))).toString('utf8')) as PublicAudioBookManifest;
      for (const chunk of book.chunks) await writeStagedAsset(join(temporary, chunk.audioUrl), await readLibraryFile(base, chunk.audioUrl.split('/')));
    }
    for (const [path, bytes] of pending) await writeStagedAsset(join(temporary, path), bytes);
    await writeStagedAsset(join(temporary, 'library/index.json'), indexBytes);
    const audit = await auditDistribution(temporary, { audience: 'personal' });
    if (books.length + previous.books.length !== library.books.length) throw new Error('Catalog entry count changed unexpectedly.');
    await rename(temporary, destination);
    return { output: destination, retained: previous.books.length, added: books.length, reused: reused.length, total: library.books.length, fileCount: audit.fileCount };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
async function main() {
  const args = process.argv.slice(2), flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--config', '--output'].includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new Error('Usage: pnpm stage:text --config ALLOWLIST --output NEW_STAGE');
    flags.set(args[i], args[i + 1]);
  }
  if (!flags.get('--config') || !flags.get('--output')) throw new Error('Explicit config and new output are required.');
  console.log(JSON.stringify(await stageTextLibrary(JSON.parse(await readFile(resolve(flags.get('--config')!), 'utf8')), flags.get('--output')!)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : 'Text staging failed.'); process.exitCode = 1; });
