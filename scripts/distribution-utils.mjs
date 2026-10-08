import { tsImport } from 'tsx/esm/api';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 20_000;
export function contentHash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function isInside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
export async function readLibraryFile(root, parts) {
  if (parts.some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..')) throw new Error('Library path is invalid.');
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Library symlinks cannot be distributed.');
  }
  const resolved = await realpath(path);
  if (!isInside(root, resolved) || !(await lstat(resolved)).isFile()) throw new Error('Library file is outside the selected root.');
  return readFile(resolved);
}
export function auditText(text, label, scanLocalCode = false) {
  if (/AIza[0-9A-Za-z_-]{35}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) throw new Error(`Possible credential in ${label}.`);
  if (!scanLocalCode && /"(?:apiKey|api_key|GEMINI_API_KEY|privateKey|access_token|refresh_token|authorization|credentials|modelPath|runtimePath|libraryDir|spokenRanges|normalizedRanges|spokenText)"\s*:/i.test(text)) {
    throw new Error(`Credential configuration field in ${label}.`);
  }
  if (scanLocalCode && /\/api\/local-(?:generation|audio)|GEMINI_API_KEY|RSVP_LIBRARY_DIR|x-goog-api-key|generativelanguage\.googleapis\.com/.test(text)) {
    throw new Error(`Local generation code or configuration in ${label}.`);
  }
}
export function validatePublicMediaMetadata(chunk) {
  const timing = chunk.timing;
  const hashes = ['sourceAudioHash', 'sourcePcmHash', 'decodedPcmHash'];
  const timingFields = new Set(['verification', 'algorithm', 'sampleRate', 'windowSeconds', 'sourcePcmDurationSeconds', 'decodedPcmDurationSeconds', 'offsetSeconds', 'scale', 'driftPpm', 'maxResidualSeconds', 'score', 'anchors', 'reason', 'durationDeltaSeconds', ...hashes]);
  if (!timing || timing.algorithm !== 'pcm-normalized-xcorr-v1' || !['pcm-correlated', 'unverified'].includes(timing.verification)
    || Object.keys(timing).some(key => !timingFields.has(key))
    || timing.sampleRate !== 24000 || hashes.some(name => !/^[a-f0-9]{64}$/.test(timing[name]))
    || (timing.windowSeconds !== undefined && (!Number.isFinite(timing.windowSeconds) || timing.windowSeconds < .08 || timing.windowSeconds > .32))
    || ['offsetSeconds', 'scale', 'driftPpm', 'maxResidualSeconds', 'score', 'sourcePcmDurationSeconds', 'decodedPcmDurationSeconds', 'durationDeltaSeconds'].some(name => !Number.isFinite(timing[name]))
    || timing.scale <= 0 || timing.maxResidualSeconds < 0 || timing.score < 0 || timing.score > 1 || !Array.isArray(timing.anchors)
    || Math.abs(timing.sourcePcmDurationSeconds - chunk.sourceDurationSeconds) > .002
    || timing.decodedPcmDurationSeconds < chunk.durationSeconds - .002 || timing.decodedPcmDurationSeconds > chunk.durationSeconds + .05) {
    throw new Error('Public PCM timing metadata is invalid. Restage from saved source audio.');
  }
  if (timing.verification === 'pcm-correlated' && (timing.anchors.length < 3 || timing.score < .8 || Math.abs(timing.offsetSeconds) > .25
    || Math.abs(timing.driftPpm) > 1000 || timing.maxResidualSeconds > .008)) throw new Error('Public codec timing exceeds the accepted verification policy.');
  for (const anchor of timing.anchors) {
    const fields = ['sourceSeconds', 'mediaSeconds', 'lagSeconds', 'correlation', 'peakMargin'];
    if (Object.keys(anchor).some(key => !fields.includes(key)) || !fields.every(name => Number.isFinite(anchor[name]))
      || anchor.correlation < -1 || anchor.correlation > 1 || anchor.peakMargin < 0
      || Math.abs(anchor.mediaSeconds - anchor.sourceSeconds - anchor.lagSeconds) > .000001
      || (timing.verification === 'pcm-correlated' && (anchor.correlation < .8 || anchor.peakMargin < .015))) throw new Error('Public PCM anchor metadata is invalid.');
  }
  const alignment = chunk.alignment;
  if (!alignment) return;
  const engine = alignment.method === 'voicevox-mora';
  const allowed = new Set(['precision', 'method', 'status', 'score', 'reason', 'normalizeVersion', 'alignerVersion', 'engineTiming', 'acoustic', 'cues', 'units', 'warnings']);
  if (Object.keys(alignment).some(key => !allowed.has(key)) || !['phrase', 'sentence'].includes(alignment.precision)
    || !['forced-alignment', 'voicevox-mora', 'sentence-fallback'].includes(alignment.method) || !['aligned', 'partial', 'fallback'].includes(alignment.status)
    || (engine ? alignment.score !== undefined : !Number.isFinite(alignment.score) || alignment.score < 0 || alignment.score > 1) || !Array.isArray(alignment.cues) || !Array.isArray(alignment.units)) {
    throw new Error('Public alignment projection contains invalid or private metadata.');
  }
  if (alignment.acoustic) {
    const proof = alignment.acoustic;
    if (timing.verification !== 'pcm-correlated' || Object.keys(proof).some(key => !['version', 'anchorCount', 'minimumTokenScore', 'units'].includes(key))
      || proof.version !== 'ctc-energy-v1' || proof.minimumTokenScore !== .75 || !Number.isSafeInteger(proof.anchorCount) || proof.anchorCount < 2
      || !Array.isArray(proof.units) || new Set(proof.units.map(unit => unit.unitId)).size !== proof.units.length) throw new Error('Public acoustic estimate evidence is invalid.');
    for (const unit of proof.units) {
      if (Object.keys(unit).some(key => !['unitId', 'blockId', 'start', 'end', 'startSeconds', 'endSeconds'].includes(key))
        || !alignment.units.some(source => source.unitId === unit.unitId && source.blockId === unit.blockId && source.start === unit.start && source.end === unit.end)
        || !Number.isFinite(unit.startSeconds) || !Number.isFinite(unit.endSeconds) || unit.startSeconds < 0 || unit.endSeconds <= unit.startSeconds || unit.endSeconds > chunk.durationSeconds + 1e-6) throw new Error('Public acoustic estimate source or media time is invalid.');
    }
  }
  if (engine) {
    const proof = alignment.engineTiming;
    const fields = ['verification', 'version', 'querySource', 'engineVersion', 'styleId', 'frameRate', 'frames', 'queryHash', 'phonemeMapping', 'ctcAnchors'];
    if (!proof || Object.keys(proof).some(key => !fields.includes(key)) || proof.verification !== 'voicevox-mora-frames' || proof.version !== 'voicevox-mora-v1'
      || !['captured', 'reconstructed'].includes(proof.querySource) || proof.engineVersion !== 'voicevox-engine:0.25.2' || !/^\d{1,8}$/.test(proof.styleId)
      || proof.frameRate !== 93.75 || !Number.isSafeInteger(proof.frames) || proof.frames <= 0 || Math.abs(proof.frames / proof.frameRate - chunk.sourceDurationSeconds) > .002
      || !/^[a-f0-9]{64}$/.test(proof.queryHash) || proof.phonemeMapping !== 'exact' || !Number.isSafeInteger(proof.ctcAnchors) || proof.ctcAnchors < 0
      || (proof.querySource === 'reconstructed' && proof.ctcAnchors < 2)) throw new Error('Public VOICEVOX timing proof is invalid.');
  } else if (alignment.engineTiming) throw new Error('Unexpected VOICEVOX timing proof.');
  if (alignment.precision === 'sentence' && alignment.cues.length) throw new Error('Sentence fallback must not claim phrase cues.');
  if (alignment.precision === 'phrase' && (timing.verification !== 'pcm-correlated' || !['forced-alignment', 'voicevox-mora'].includes(alignment.method) || !alignment.cues.length)) {
    throw new Error('Phrase cues require measured PCM timing verification.');
  }
  let previousEnd = 0;
  for (const cue of alignment.cues) {
    if (Object.keys(cue).some(key => !['unitId', 'unitIds', 'blockId', 'start', 'end', 'startSeconds', 'endSeconds', 'score'].includes(key))
      || !Number.isFinite(cue.startSeconds) || !Number.isFinite(cue.endSeconds) || cue.startSeconds < 0 || cue.endSeconds <= cue.startSeconds
      || cue.endSeconds > chunk.durationSeconds || cue.startSeconds + .001 < previousEnd || (engine ? cue.score !== undefined : !Number.isFinite(cue.score) || cue.score < .75 || cue.score > 1)) {
      throw new Error('Public phrase cues are invalid or below the accepted score.');
    }
    previousEnd = cue.endSeconds;
  }
  for (const unit of alignment.units) {
    if (Object.keys(unit).some(key => !['unitId', 'blockId', 'start', 'end', 'score', 'status', 'reason'].includes(key))
      || !['aligned', 'low-confidence', 'unmatched'].includes(unit.status) || (engine ? unit.score !== undefined || unit.status !== 'aligned' : !Number.isFinite(unit.score) || unit.score < 0 || unit.score > 1)) {
      throw new Error('Public unit projection contains invalid or private metadata.');
    }
  }
}
let presentationModule;
let publicLibraryModule;
export async function validatePublicPresentation(manifest) {
  presentationModule ??= tsImport('../apps/web/src/reader/audio-presentation.ts', import.meta.url);
  (await presentationModule).requireAudioPresentation(manifest, true);
}

/** Audits the actual upload tree, not just the UI's navigation. */
export async function auditDistribution(directory, options = {}) {
  directory = await realpath(directory);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 100_000) throw new Error('File limit must be between 1 and 100000.');
  const files = [];
  async function visit(path, rel) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Distribution symlink: ${rel}`);
    if (rel.split('/').some(part => part.startsWith('.') || /^(?:jobs|sources|cache|plans|locks|node_modules|server|source|models|alignment-runtime|alignment-cache|voicevox-queries|voicevox-timing-cache|audio-media|audio-archive)$/.test(part))) {
      throw new Error(`Private or server file in distribution: ${rel}`);
    }
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), rel ? `${rel}/${name}` : name);
    } else {
      if (!info.isFile()) throw new Error(`Unsupported distribution entry: ${rel}`);
      if (/\.(?:onnx|safetensors|pt|pth|ckpt|pkl)$/.test(rel)) throw new Error(`Model/runtime file in distribution: ${rel}`);
      if (info.size > MAX_ASSET_BYTES) throw new Error(`Asset exceeds 25 MiB: ${rel}`);
      files.push({ path: rel, bytes: info.size });
      if (files.length > maxFiles) throw new Error(`Static asset count exceeds ${maxFiles}.`);
      if (/\.(?:js|mjs|cjs|html|json|map|txt|md|css|svg)$/.test(rel)) {
        const text = await readFile(path, 'utf8');
        auditText(text, rel, /\.(?:js|mjs|cjs|html|map)$/.test(rel));
        if (/^(?:samples\/audio\/)?library\/books\/[^/]+\/[^/]+\/manifest\.json$/.test(rel)) {
          const manifest = JSON.parse(text);
          if (!Array.isArray(manifest.chunks)) throw new Error('Public manifest chunks are invalid.');
          for (const chunk of manifest.chunks) validatePublicMediaMetadata(chunk);
          await validatePublicPresentation(manifest);
        }
      }
    }
  }
  await visit(directory, '');
  let audioBooks = 0;
  // The bundled sample catalog has its own subtree; audit it as strictly as staged books.
  for (const prefix of ['', 'samples/audio/']) {
    const catalog = `${prefix}library/index.json`;
    const parts = prefix ? prefix.slice(0, -1).split('/') : [];
    if (files.some(file => file.path === catalog)) {
      publicLibraryModule ??= tsImport('../apps/web/src/distribution/library.ts', import.meta.url);
      const library = (await publicLibraryModule).parsePublicLibrary(JSON.parse(await readFile(join(directory, catalog), 'utf8')));
      if (options.audience === 'demo' && ((library.audience ?? 'demo') !== 'demo' || library.books.some(book => !book.publicDemo))) throw new Error('Personal library cannot enter a demo distribution.');
      if (prefix && ((library.audience ?? 'demo') !== 'demo' || library.books.some(book => !book.publicDemo))) throw new Error('Bundled samples must be explicitly public demos.');
      const referenced = new Set([catalog, `${prefix}library/audio-sizes.json`]);
      for (const entry of library.books) {
        const bytes = await readLibraryFile(directory, [...parts, ...entry.manifestUrl.split('/')]);
        if (bytes.byteLength !== entry.manifestBytes || contentHash(bytes) !== entry.manifestSha256) throw new Error('Catalog manifest hash/size mismatch.');
        const book = JSON.parse(bytes.toString('utf8'));
        if (book.id !== entry.id || book.revision !== entry.revision || book.schemaVersion !== 1
          || !Number.isFinite(book.durationSeconds) || Math.abs(book.durationSeconds - entry.durationSeconds) > 1e-6
          || Math.abs(book.durationSeconds - book.chunks.reduce((sum, chunk) => sum + chunk.durationSeconds, 0)) > 1e-6) throw new Error('Catalog book identity/duration mismatch.');
        await validatePublicPresentation(book); referenced.add(prefix + entry.manifestUrl);
        for (const chunk of book.chunks) {
          const extension = chunk.mimeType === 'audio/mp4' ? 'm4a' : chunk.mimeType === 'audio/mpeg' ? 'mp3' : undefined;
          if (!extension || chunk.audioUrl !== `library/books/${entry.id}/${entry.revision}/media/${chunk.sha256}.${extension}`) throw new Error('Unexpected audio reference.');
          const audio = await readLibraryFile(directory, [...parts, ...chunk.audioUrl.split('/')]);
          if (audio.byteLength !== chunk.bytes || contentHash(audio) !== chunk.sha256) throw new Error('Selected audio hash/size mismatch.');
          referenced.add(prefix + chunk.audioUrl);
        }
        audioBooks++;
      }
      if (files.some(file => file.path.startsWith(`${prefix}library/`) && !referenced.has(file.path))) throw new Error('Unselected library asset in upload tree.');
    } else if (files.some(file => file.path.startsWith(`${prefix}library/books/`))) throw new Error('Selected audio catalog is missing.');
  }
  return { audioBooks, fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
}
