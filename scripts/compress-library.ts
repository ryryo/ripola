import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AlignmentJob, AudioBookManifest, GenerationJob } from '../apps/web/src/generation/contracts.ts';
import { compressedAudioRecord, readReadyAudio, type AudioCacheRecord } from '../apps/web/src/generation/core/audio-cache.ts';
import { digest, LibraryDisk, processAlive, requireId, requireKey } from '../apps/web/src/generation/core/disk.ts';
import { requireAudioPresentation } from '../apps/web/src/reader/audio-presentation.ts';
import { encodeVerifiedMp3 } from '../apps/web/src/generation/core/audio-compression.ts';
export interface CompressionSelection { libraryDir: string; books: Array<{ id: string; revision: string }> }
export interface CompressionOptions { action: 'convert' | 'archive-wav' | 'restore-wav'; apply?: boolean; writersStopped?: boolean; operation?: string; onProgress?: (files: FileReport[]) => Promise<void> }
export interface FileReport { speechKey: string; sourceAudioHash: string; status: 'planned' | 'converted' | 'reused' | 'archived' | 'restored' | 'retained'; wavPath: string; mp3Path: string; sourceBytes: number; mp3Bytes?: number; archivePath?: string; reason?: string }

async function selection(disk: LibraryDisk, config: CompressionSelection): Promise<AudioBookManifest[]> {
  if (!Array.isArray(config.books) || !config.books.length || config.books.length > 1000
    || new Set(config.books.map(b => `${b.id}/${b.revision}`)).size !== config.books.length) throw new Error('Explicit unique book/revision selection is required.');
  const books: AudioBookManifest[] = [];
  const jobs = await Promise.all((await disk.list('jobs')).map(file => disk.read<GenerationJob>(['jobs', file])));
  const alignments = await Promise.all((await disk.list('alignment-jobs')).map(file => disk.read<AlignmentJob>(['alignment-jobs', file])));
  for (const selected of config.books) {
    requireId(selected.id); requireKey(selected.revision);
    const book = await disk.read<AudioBookManifest>(['books', `${selected.id}_${selected.revision}.json`]);
    if (!book || book.id !== selected.id || book.revision !== selected.revision || book.completedChunks !== book.totalChunks || book.chunks.length !== book.totalChunks) throw new Error('Only complete selected book revisions may be migrated.');
    const job = jobs.find(j => j?.bookId === book.id && j.revision === book.revision && j.status === 'completed'
      && j.completedChunks === j.totalChunks && j.totalChunks === book.totalChunks);
    const alignment = alignments.find(j => j && j.bookId === book.id && j.revision === book.revision && j.status === 'completed'
      && j.completedChunks === j.totalChunks && book.chunks.every(c => j.chunks.some(s => s.id === c.id && s.speechKey === c.speechKey && s.status === 'completed')));
    if (!job || !alignment || !book.chunks.every(c => c.alignment)) throw new Error('Finish and save synchronization correction before MP3 migration; original WAV is required.');
    requireAudioPresentation(book);
    books.push(book);
  }
  return books;
}
async function noWriters(disk: LibraryDisk, options: CompressionOptions): Promise<void> {
  if (!options.writersStopped) throw new Error('Stop old WAV-only controllers/writers, then explicitly supply --writers-stopped.');
  for (const folder of ['jobs', 'alignment-jobs']) for (const file of await disk.list(folder)) {
    const job = await disk.read<{ status?: string }>([folder, file]);
    if (job && ['queued', 'running', 'cancel-requested'].includes(job.status ?? '')) throw new Error('Active generation/alignment job exists. WAV archival/restoration is blocked.');
  }
  // Owners can survive completed jobs. Active run locks provide a second guard.
  const { readdir } = await import('node:fs/promises');
  let locks: string[] = [];
  try { locks = await readdir(join(disk.root, 'locks')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const file of locks.filter(f => /^(run-|alignrun-|speech-).*\.lock$/.test(f))) {
    const owner = await disk.read<{ pid: number }>(['locks', file]);
    if (owner && Number.isInteger(owner.pid) && processAlive(owner.pid)) throw new Error('A generation/alignment writer still holds a live lock.');
  }
}
export async function compressLibrary(config: CompressionSelection, options: CompressionOptions) {
  if (!config || typeof config.libraryDir !== 'string' || !config.libraryDir.trim()) throw new Error('Explicit libraryDir is required.');
  if (!['convert', 'archive-wav', 'restore-wav'].includes(options.action)) throw new Error('Unknown action.');
  const disk = new LibraryDisk(resolve(config.libraryDir));
  const books = await selection(disk, config);
  const selected = new Set(books.map(b => `${b.id}/${b.revision}`));
  const chunks = new Map(books.flatMap(b => b.chunks.map(c => [c.speechKey, c] as const)));
  const shared = new Set<string>();
  for (const file of await disk.list('books')) {
    const other = await disk.read<AudioBookManifest>(['books', file]);
    if (other && !selected.has(`${other.id}/${other.revision}`)) for (const c of other.chunks ?? []) if (chunks.has(c.speechKey)) shared.add(c.speechKey);
  }
  if (options.action !== 'convert') {
    requireId(options.operation);
    // The read-only plan is available before stopping any writer.
    if (options.apply) await noWriters(disk, options);
  }
  const files: FileReport[] = [];
  for (const [key, chunk] of chunks) {
    requireKey(key);
    const cache = await disk.read<AudioCacheRecord>(['cache', `${key}.json`]);
    if (cache?.status !== 'ready' || chunk.alignment?.audioHash !== cache.hash || cache.durationSeconds !== chunk.durationSeconds) throw new Error('Completed source audio and correction hashes/clocks differ.');
    const wavPath = join(disk.root, 'audio', `${key}.wav`), mp3Path = join(disk.root, 'audio', `${key}.mp3`);
    const media = await compressedAudioRecord(disk, key, cache);
    const source = await disk.readBytes(['audio', `${key}.wav`]);
    const row: FileReport = { speechKey: key, sourceAudioHash: cache.hash!, status: 'planned', wavPath, mp3Path, sourceBytes: source?.length ?? media?.sourceBytes ?? 0, ...(media ? { mp3Bytes: media.bytes } : {}) };
    files.push(row);
    if (shared.has(key)) { row.status = 'retained'; row.reason = 'Referenced by an unselected book; its media/WAV remain unchanged.'; continue; }
    if (options.action !== 'convert') row.archivePath = join(disk.root, 'audio-archive', options.operation!, `${key}.wav`);
    if (!options.apply) continue;
    // Persist exact intent before any reversible move. The CLI keeps this report
    // even if interrupted between a rename and its final completion record.
    await options.onProgress?.(files);
    const release = await disk.lock(`speech-${key}`);
    if (!release) throw new Error('Selected speech is in use by another writer.');
    try {
      if (options.action === 'convert') {
        if (media) { await readReadyAudio(disk, key, 'mp3'); row.status = 'reused'; }
        else {
          try { const created = await encodeVerifiedMp3(disk, key, cache); row.mp3Bytes = created.bytes; row.status = 'converted'; }
          catch (error) { row.status = 'retained'; row.reason = error instanceof Error ? error.message : 'MP3 verification failed; WAV retained.'; }
        }
      } else if (options.action === 'archive-wav') {
        if (!media) { row.status = 'retained'; row.reason = 'No verified MP3; WAV retained.'; continue; }
        await readReadyAudio(disk, key, 'mp3');
        if (!source || digest(source) !== cache.hash) throw new Error('Archival requires the original matching WAV.');
        await disk.move(['audio', `${key}.wav`], ['audio-archive', options.operation!, `${key}.wav`]);
        row.status = 'archived';
      } else {
        const archived = await disk.readBytes(['audio-archive', options.operation!, `${key}.wav`]);
        if (!archived || digest(archived) !== cache.hash) throw new Error('Archived WAV hash does not match the original.');
        await disk.move(['audio-archive', options.operation!, `${key}.wav`], ['audio', `${key}.wav`]);
        if (media) await disk.move(['audio-media', `${key}.json`], ['audio-archive', options.operation!, `${key}.json`]);
        row.status = 'restored';
      }
    } finally { await release(); await options.onProgress?.(files); }
  }
  return { schemaVersion: 1, action: options.action, applied: options.apply === true, libraryDir: disk.root, books: config.books, files,
    verifiedMp3Files: files.filter(f => f.mp3Bytes).length, retainedWavFiles: files.filter(f => f.status === 'retained').length,
    originalWavBytes: files.reduce((n, f) => n + f.sourceBytes, 0), mp3Bytes: files.reduce((n, f) => n + (f.mp3Bytes ?? 0), 0),
    archivedBytes: files.filter(f => f.status === 'archived').reduce((n, f) => n + f.sourceBytes, 0), actualSpaceReclaimedBytes: 0,
    irreversibleDeletionPerformed: false, note: 'Archival is reversible on the same disk and does not recover free space. Exact archived paths/bytes are listed for separate review; this command never purges WAV.' };
}
async function main() {
  const args = process.argv.slice(2), flags = new Map<string, string>(); let apply = false, writersStopped = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') { apply = true; continue; }
    if (args[i] === '--writers-stopped') { writersStopped = true; continue; }
    if (!['--config', '--report', '--action', '--operation'].includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new Error('Usage: compress-library.ts --config selection.json --report new-report.json [--action convert|archive-wav|restore-wav] [--operation archive-id] [--apply] [--writers-stopped]');
    flags.set(args[i], args[++i]);
  }
  if (!flags.has('--config') || !flags.has('--report')) throw new Error('Explicit config and a new report path are required.');
  const config = JSON.parse(await readFile(resolve(flags.get('--config')!), 'utf8')) as CompressionSelection;
  const reportPath = resolve(flags.get('--report')!);
  const action = (flags.get('--action') ?? 'convert') as CompressionOptions['action'];
  let currentFiles: FileReport[] = [];
  const saveProgress = async (files: FileReport[]) => { currentFiles = files; await writeFile(reportPath, JSON.stringify({ schemaVersion: 1, status: 'in-progress', action, libraryDir: config.libraryDir, books: config.books, files }, null, 2) + '\n', { mode: 0o600 }); };
  // Reject an existing report before touching any selected audio.
  await writeFile(reportPath, JSON.stringify({ schemaVersion: 1, status: 'starting', action, files: [] }) + '\n', { mode: 0o600, flag: 'wx' });
  let report;
  try { report = await compressLibrary(config, { action, apply, writersStopped, operation: flags.get('--operation'), onProgress: saveProgress }); }
  catch (error) { await writeFile(reportPath, JSON.stringify({ schemaVersion: 1, status: 'failed', action, files: currentFiles, error: error instanceof Error ? error.message : 'Migration failed' }, null, 2) + '\n', { mode: 0o600 }); throw error; }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ books: config.books.length, files: report.files.length, converted: report.files.filter(f => f.status === 'converted').length, retained: report.retainedWavFiles, archivedBytes: report.archivedBytes, irreversibleDeletionPerformed: false, report: resolve(flags.get('--report')!) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : 'Migration failed.'); process.exitCode = 1; });
