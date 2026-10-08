import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AudioBookManifest, AudioTimelineEntry } from '../apps/web/src/generation/contracts';
import { publicReadingDocument, validContentHash, validDistributionId, type PublicAudioBookManifest, type PublicAudioChunk, type PublicLibraryManifest } from '../apps/web/src/distribution/library.ts';
import { auditDistribution, auditText, contentHash, isInside, readLibraryFile } from './distribution-utils.mjs';
import { estimateMediaTiming } from './media-timing.ts';
import { requireAudioPresentation } from '../apps/web/src/reader/audio-presentation.ts';
import { publicAlignment } from './public-alignment.ts';
import { readReadyAudio } from '../apps/web/src/generation/core/audio-cache.ts';
import { LibraryDisk } from '../apps/web/src/generation/core/disk.ts';
import { decodeTimingPcm } from '../apps/web/src/generation/core/audio-compression.ts';
export { decodeTimingPcm } from '../apps/web/src/generation/core/audio-compression.ts';

const run = promisify(execFile);
export interface StageBookSelection { id: string; revision: string; rightsConfirmed: true; publicDemo?: boolean; attribution: string }
export interface StageLibraryConfig { audience?: 'demo' | 'personal'; target: 'pages' | 'worker'; mediaFormat?: 'aac' | 'mp3'; libraryDir: string; books: StageBookSelection[] }
export interface StageOptions { output: string; maxFiles?: number }
export function validateStageConfig(input: unknown): StageLibraryConfig {
  if (!input || typeof input !== 'object') throw new Error('An explicit staging allowlist is required.');
  const config = input as StageLibraryConfig;
  if (!['pages', 'worker'].includes(config.target) || typeof config.libraryDir !== 'string' || !config.libraryDir.trim()
    || !Array.isArray(config.books) || !config.books.length || config.books.length > 1000) throw new Error('The staging allowlist is invalid.');
  const audience = config.audience ?? 'demo';
  if (config.mediaFormat !== undefined && !['aac', 'mp3'].includes(config.mediaFormat)) throw new Error('Unsupported distribution audio format.');
  if (!['demo', 'personal'].includes(audience) || audience === 'personal' && config.target !== 'worker') throw new Error('Personal distribution requires target=worker.');
  for (const book of config.books) {
    if (!validDistributionId(book.id) || !validDistributionId(book.revision) || book.rightsConfirmed !== true
      || typeof book.attribution !== 'string' || !book.attribution.trim() || (audience === 'demo' && book.publicDemo !== true)) {
      throw new Error('Each selected book needs explicit rights confirmation and attribution; Demo distribution requires publicDemo=true; personal books require audience=personal.');
    }
  }
  if (new Set(config.books.map(book => `${book.id}/${book.revision}`)).size !== config.books.length) throw new Error('Duplicate book revision in allowlist.');
  return { ...config, audience };
}
async function audioInfo(path: string, expectedCodec?: 'aac'): Promise<{ durationSeconds: number }> {
  let stdout: string;
  try {
    ({ stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,profile,channels,sample_rate', '-of', 'json', path], { encoding: 'utf8', maxBuffer: 256 * 1024, timeout: 30_000 }));
  } catch { throw new Error('ffprobe is required to verify compressed audio. Install/configure it separately; no TTS was rerun.'); }
  const info = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_name?: string; profile?: string; channels?: number; sample_rate?: string }> };
  const durationSeconds = Number(info.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !info.streams?.length) throw new Error('Audio duration could not be verified.');
  if (expectedCodec && (info.streams.length !== 1 || info.streams[0].codec_name !== 'aac' || info.streams[0].profile !== 'LC'
    || info.streams[0].channels !== 1 || Number(info.streams[0].sample_rate) !== 24_000)) {
    throw new Error('Compressed audio does not match the AAC-LC/mono/24kHz profile.');
  }
  return { durationSeconds };
}
function timeline(entries: AudioTimelineEntry[], sourceDuration: number, mediaDuration: number): AudioTimelineEntry[] {
  // Only single sentence chunks are supported: AAC container boundaries replace whole-sentence endpoints.
  if (entries.length !== 1 || entries[0].precision !== 'sentence' || Math.abs(entries[0].startSeconds) > .001
    || Math.abs(entries[0].endSeconds - sourceDuration) > .05) throw new Error('Only verified whole-sentence timelines can currently be staged.');
  const mark = entries[0];
  return [{ chunkId: mark.chunkId, blockId: mark.blockId, start: mark.start, end: mark.end, unitIds: [...mark.unitIds], startSeconds: 0, endSeconds: mediaDuration, precision: 'sentence' }];
}
async function compress(input: string, output: string): Promise<void> {
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input, '-map_metadata', '-1', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '24000', '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '64k', '-movflags', '+faststart', output], { maxBuffer: 256 * 1024, timeout: 120_000 });
  } catch { throw new Error('AAC compression failed or ffmpeg is unavailable. Source audio is unchanged; no TTS was rerun.'); }
}
export async function stageLibrary(input: unknown, options: StageOptions): Promise<{ output: string; books: number; fileCount: number; totalBytes: number }> {
  const config = validateStageConfig(input);
  const configuredRoot = resolve(config.libraryDir);
  if ((await lstat(configuredRoot)).isSymbolicLink()) throw new Error('Library root must not be a symlink.');
  const root = await realpath(configuredRoot);
  const output = resolve(options.output);
  const repository = fileURLToPath(new URL('../', import.meta.url));
  if (config.audience === 'personal' && isInside(repository, output) && !isInside(join(repository, 'staging-private'), output)) throw new Error('Personal staging must use staging-private or a directory outside the repository.');
  await mkdir(dirname(output), { recursive: true });
  const parent = await realpath(dirname(output));
  if (isInside(root, join(parent, basename(output))) || isInside(output, root)) throw new Error('Staging output must be separate from the original library.');
  try { await lstat(output); throw new Error('Staging output already exists. Choose a new directory; existing artifacts are preserved.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = await mkdtemp(join(parent, '.rsvp-stage-'));
  const library: PublicLibraryManifest = { schemaVersion: 1, target: config.target, audience: config.audience, createdAt: new Date().toISOString(), books: [] };
  try {
    for (const selected of config.books) {
      const sourceBytes = await readLibraryFile(root, ['books', `${selected.id}_${selected.revision}.json`]);
      const saved = JSON.parse(sourceBytes.toString('utf8')) as AudioBookManifest;
      if (saved.schemaVersion !== 1 || saved.id !== selected.id || saved.revision !== selected.revision || saved.precision !== 'sentence'
        || !Array.isArray(saved.chunks) || !saved.chunks.length || saved.completedChunks !== saved.totalChunks || saved.chunks.length !== saved.totalChunks) {
        throw new Error('Only a complete, matching generated book revision can be staged.');
      }
      requireAudioPresentation(saved);
      const prefix = `library/books/${selected.id}/${selected.revision}`;
      await mkdir(join(temporary, prefix, 'media'), { recursive: true });
      const chunks: PublicAudioChunk[] = [];
      for (const chunk of saved.chunks) {
        if (!validDistributionId(chunk.id) || !validContentHash(chunk.speechKey) || !['audio/wav', 'audio/mpeg'].includes(chunk.mimeType)
          || !Number.isFinite(chunk.durationSeconds) || chunk.durationSeconds <= 0) throw new Error('Generated audio metadata is invalid.');
        let audio;
        try { audio = await readReadyAudio(new LibraryDisk(root), chunk.speechKey); }
        catch { throw new Error('Saved audio content hash or completion state does not match its cache metadata.'); }
        if (!audio) throw new Error('Saved audio content hash or completion state does not match its cache metadata.');
        const { bytes, cache } = audio;
        if (cache.schemaVersion !== 1 || !validContentHash(cache.hash) || (chunk.mimeType === 'audio/mpeg' && audio.format !== 'mp3')
          || !Number.isFinite(cache.durationSeconds) || Math.abs(Number(cache.durationSeconds) - chunk.durationSeconds) > .05) {
          throw new Error('Saved audio content hash or completion state does not match its cache metadata.');
        }
        if (config.mediaFormat !== 'aac' && audio.media) {
          // Copy the already verified gapless MP3. The proof binds its bytes to
          // the unchanged WAV clock; no second lossy encode is needed.
          const media = audio.media, proof = media.verification;
          const audioUrl = `${prefix}/media/${media.hash}.mp3`;
          try { await writeFile(join(temporary, audioUrl), bytes, { mode: 0o600, flag: 'wx' }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || contentHash(await readFile(join(temporary, audioUrl))) !== media.hash) throw error; }
          chunks.push({ id: chunk.id, audioUrl, mimeType: 'audio/mpeg', durationSeconds: media.durationSeconds, sourceDurationSeconds: media.durationSeconds,
            sha256: media.hash, bytes: bytes.byteLength, timeline: timeline(chunk.timeline, media.durationSeconds, media.durationSeconds),
            alignment: publicAlignment(chunk.alignment, saved.document, chunk.timeline, cache.hash, media.durationSeconds, media.durationSeconds, proof.timing),
            timing: { ...proof.timing, durationDeltaSeconds: 0, sourceAudioHash: cache.hash, sourcePcmHash: proof.sourcePcmHash, decodedPcmHash: proof.decodedPcmHash } });
          continue;
        }
        const inputPath = join(temporary, `${chunk.speechKey}.${audio.format}`);
        const compressedPath = join(temporary, prefix, 'media', `${chunk.id}.m4a`);
        await writeFile(inputPath, bytes, { mode: 0o600, flag: 'wx' });
        // MP3 container duration can include encoder delay/padding. Its verified
        // gapless decoded clock, not that container duration, is the source clock.
        const original = audio.media ? { durationSeconds: audio.media.durationSeconds } : await audioInfo(inputPath);
        if (Math.abs(original.durationSeconds - chunk.durationSeconds) > .05) throw new Error('Saved timeline and source audio durations disagree.');
        await compress(inputPath, compressedPath);
        const media = await audioInfo(compressedPath, 'aac');
        // The container can include a small codec frame boundary difference; no word timestamps are claimed.
        if (Math.abs(media.durationSeconds - original.durationSeconds) > .1) throw new Error('Compressed audio timing differs by more than 100 ms; inspect before distribution.');
        const sourcePcm = await decodeTimingPcm(inputPath);
        if (Math.abs(sourcePcm.samples.length / 24000 - original.durationSeconds) > .002) throw new Error('Decoded source audio clock differs from the saved timeline.');
        const mediaPcm = await decodeTimingPcm(compressedPath);
        const measurement = estimateMediaTiming(sourcePcm.samples, mediaPcm.samples);
        await rm(inputPath);
        const mediaBytes = await readFile(compressedPath);
        const hash = contentHash(mediaBytes);
        const audioUrl = `${prefix}/media/${hash}.m4a`;
        await rename(compressedPath, join(temporary, audioUrl));
        chunks.push({ id: chunk.id, audioUrl, mimeType: 'audio/mp4', durationSeconds: media.durationSeconds, sourceDurationSeconds: original.durationSeconds,
          sha256: hash, bytes: mediaBytes.byteLength, timeline: timeline(chunk.timeline, original.durationSeconds, media.durationSeconds),
          alignment: publicAlignment(chunk.alignment, saved.document, chunk.timeline, cache.hash, original.durationSeconds, media.durationSeconds, measurement),
          timing: { ...measurement, durationDeltaSeconds: media.durationSeconds - original.durationSeconds, sourceAudioHash: audio.media?.hash ?? cache.hash,
            sourcePcmHash: sourcePcm.hash, decodedPcmHash: mediaPcm.hash } });
      }
      const document = publicReadingDocument(saved.document);
      const manifest: PublicAudioBookManifest = {
        schemaVersion: 1, id: selected.id, revision: selected.revision, title: saved.title, updatedAt: saved.updatedAt,
        document, chunks, completedChunks: chunks.length, totalChunks: chunks.length, durationSeconds: chunks.reduce((sum, chunk) => sum + chunk.durationSeconds, 0),
        precision: 'sentence', attribution: selected.attribution,
        warnings: [chunks.some(chunk => chunk.alignment?.precision === 'phrase')
          ? '採用したフレーズcueは配布音声の復号PCMとの相互相関で時計を検証しています。低score・未対応・無音の範囲の表示時刻は表示用推定です。CTC scoreは校正された精度の確率ではありません。'
          : '区切り表示は全原稿位置を検査します。音声から時刻を検証できない範囲は表示用推定を使い、整列時刻とは区別します。',
        'PCMの検証はローカルffmpegの復号結果です。各ブラウザ・実スマホのdecoderの差や文節の人手境界精度を保証しません。',
        '選択した本文・rawText・読み表示用の位置情報を配布に含めます。元PDF/MDファイルや生成設定・ログ・モデル/runtimeは含めません。'],
      };
      manifest.presentation = requireAudioPresentation(manifest);
      const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
      auditText(new TextDecoder().decode(manifestBytes), 'selected book');
      const manifestUrl = `${prefix}/manifest.json`;
      await writeFile(join(temporary, manifestUrl), manifestBytes, { mode: 0o600, flag: 'wx' });
      library.books.push({ id: selected.id, revision: selected.revision, title: saved.title, manifestUrl, manifestSha256: contentHash(manifestBytes), manifestBytes: manifestBytes.byteLength,
        durationSeconds: manifest.durationSeconds, precision: 'sentence', attribution: selected.attribution, publicDemo: selected.publicDemo === true });
    }
    await writeFile(join(temporary, 'library/index.json'), `${JSON.stringify(library)}\n`, { mode: 0o600, flag: 'wx' });
    const report = await auditDistribution(temporary, { maxFiles: options.maxFiles });
    await rename(temporary, output);
    return { output, books: library.books.length, fileCount: report.fileCount, totalBytes: report.totalBytes };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    if (!['--config', '--output', '--max-files'].includes(args[index]) || !args[index + 1] || flags.has(args[index])) throw new Error('Usage: node --import tsx scripts/stage-library.ts --config <allowlist.json> --output <new-stage-dir> [--max-files 20000]');
    flags.set(args[index], args[index + 1]);
  }
  if (!flags.get('--config') || !flags.get('--output')) throw new Error('Explicit --config and --output are required.');
  const input = JSON.parse(await readFile(resolve(flags.get('--config')!), 'utf8')) as unknown;
  const report = await stageLibrary(input, { output: flags.get('--output')!, ...(flags.has('--max-files') ? { maxFiles: Number(flags.get('--max-files')) } : {}) });
  console.log(JSON.stringify({ ...report, note: 'Selected full text is included. No deployment or TTS request was performed.' }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Staging failed.'); process.exitCode = 1; });
}
