import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { AlignmentWorker, trackAlignmentProcess } from './alignment-worker';
import type { GenerationServerConfig } from './config';
import type { AlignmentStatus } from '../contracts';

export interface AlignmentRuntimeRequest {
  schemaVersion: 1;
  audioPath: string;
  audioHash: string;
  spokenText: string;
  normalizedText: string;
  normalizeVersion: string;
  alignerVersion: string;
  offsetUnit: 'utf16';
}
export interface AlignmentRuntimeSegment {
  start: number;
  end: number;
  startSeconds?: number;
  endSeconds?: number;
  /** Probability along a supplied-transcript CTC path; never independent ASR accuracy. */
  confidence: number;
  status: AlignmentStatus;
}
export interface SpeechActivity {
  version: 'pcm-rms-v1';
  frameSeconds: 0.01;
  thresholdRms: number;
  intervals: Array<{ startSeconds: number; endSeconds: number }>;
}
export interface AlignmentRuntimeResult {
  schemaVersion: 1;
  alignerVersion: string;
  normalizeVersion: string;
  offsetUnit: 'utf16';
  normalizedText: string;
  durationSeconds: number;
  segments: AlignmentRuntimeSegment[];
  speechActivity?: SpeechActivity;
  warnings?: string[];
}
export interface AlignmentAdapter {
  version: string;
  available(): Promise<boolean>;
  readiness?(): Promise<{ status: 'ready' | 'setup-required' | 'failed'; message: string }>;
  align(request: AlignmentRuntimeRequest, signal: AbortSignal): Promise<AlignmentRuntimeResult>;
  /** Wait for worker/process-tree cleanup. No unfinished request is replayed. */
  close?(): Promise<void>;
}

function safeChildEnv(modelDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'OMP_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, RSVP_ALIGNMENT_MODEL_DIR: modelDir, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false', PYTHONDONTWRITEBYTECODE: '1' };
}
type Readiness = { status: 'ready' | 'setup-required' | 'failed'; message: string };
const PINNED_VERSION = 'reazon-rs35kh-46afc596-ctc-v2';

/** Existence/size checks happen before spawn. Python verifies pinned hashes before loading. */
async function resourcesIdentity(config: GenerationServerConfig, version: string): Promise<string> {
  const { alignmentPython: python, alignmentScript: script, alignmentModelDir: modelDir } = config;
  if (!python || !script || !modelDir || ![python, script, modelDir].every(isAbsolute) || version !== PINNED_VERSION) throw new Error('unconfigured-runtime');
  await access(python, constants.X_OK); await access(script, constants.R_OK);
  if (!(await stat(modelDir)).isDirectory()) throw new Error('missing-model');
  const directory = dirname(script);
  const manifestBytes = await readFile(join(directory, 'alignment-model.json'));
  const manifest = JSON.parse(manifestBytes.toString()) as { schemaVersion: number; alignerVersion: string; files: Array<{ filename: string; bytes: number }> };
  if (manifest.schemaVersion !== 1 || manifest.alignerVersion !== version || !manifest.files?.length) throw new Error('invalid-manifest');
  const assets = [python, script, config.alignmentCheckScript ?? join(directory, 'check-alignment-runtime.py'), join(directory, 'alignment_runtime.py'), join(directory, 'alignment_worker.py'), join(directory, 'alignment-platforms.json'), join(directory, 'alignment-requirements.txt'), join(directory, 'alignment-requirements-linux-x64.txt')];
  for (const entry of manifest.files) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(entry.filename)) throw new Error('invalid-model-path');
    const path = join(modelDir, entry.filename);
    if (!(await stat(path)).isFile() || (await stat(path)).size !== entry.bytes) throw new Error('missing-model-file');
    assets.push(path);
  }
  const fingerprint = await Promise.all(assets.map(async path => {
    const info = await stat(path, { bigint: true });
    return [await realpath(path), info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String);
  }));
  return createHash('sha256').update(manifestBytes).update(JSON.stringify(fingerprint)).digest('hex');
}

export function pythonAlignmentAdapter(config: GenerationServerConfig): AlignmentAdapter {
  const version = config.alignmentVersion ?? PINNED_VERSION;
  let cached: { identity: string; until: number; result: Promise<Readiness> } | undefined;
  let closed = false;
  const probes = new Map<ChildProcess, Promise<void>>();
  const worker = new AlignmentWorker({
    command: config.alignmentPython ?? '', args: [config.alignmentScript ?? '', '--worker'],
    cwd: dirname(config.alignmentScript ?? '.'), env: safeChildEnv(config.alignmentModelDir ?? ''), alignerVersion: version,
    prepare: () => resourcesIdentity(config, version), onStopped: () => { cached = undefined; },
  });
  const readiness = async (): Promise<Readiness> => {
    if (closed) return { status: 'failed', message: 'alignment workerは終了済みです。新しいserviceで開始してください。' };
    if (!config.alignmentPython || !config.alignmentScript || !config.alignmentModelDir) return { status: config.alignmentSetupState === 'failed' ? 'failed' : 'setup-required', message: 'リポジトリのフォルダーで pnpm setup:audio を実行し、完了後 pnpm dev を起動してください。' };
    try {
      const identity = await resourcesIdentity(config, version);
      if (closed) throw new Error('adapter-closed');
      if (worker.readyFor(identity)) return { status: 'ready', message: '新しい音声を保存した後に、このPCで時刻を自動補正します。' };
      if (cached && cached.identity === identity && cached.until > Date.now()) return cached.result;
      const result = (async (): Promise<Readiness> => {
        try {
          const check = config.alignmentCheckScript ?? join(dirname(config.alignmentScript!), 'check-alignment-runtime.py');
          const execution = promisify(execFile)(config.alignmentPython!, [check, '--model-dir', config.alignmentModelDir!], { env: safeChildEnv(config.alignmentModelDir!), timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
          const child = execution.child;
          const cleanup = new Promise<void>(resolve => child.once('close', () => resolve()));
          const unregister = trackAlignmentProcess(child, false);
          probes.set(child, cleanup);
          try { await execution; }
          finally { await cleanup; unregister(); probes.delete(child); }
          if (closed) throw new Error('adapter-closed');
          if (identity !== await resourcesIdentity(config, version) || closed) throw new Error('resources-changed');
          return { status: 'ready', message: '新しい音声を保存した後に、このPCで時刻を自動補正します。' };
        } catch { return { status: 'failed', message: 'Python・依存・モデル・ffmpegの確認に失敗しました。pnpm setup:audio を再実行し、起動中なら pnpm dev を再起動してください。' }; }
      })();
      cached = { identity, until: Date.now() + 30_000, result }; return result;
    } catch {
      cached = undefined;
      return { status: 'failed', message: 'Python・依存・既存モデルを確認できません。pnpm setup:audioの設定を確認してください。' };
    }
  };
  return {
    version,
    async available() { return (await readiness()).status === 'ready'; },
    readiness,
    align: (request, signal) => worker.align(request, signal),
    async close() {
      closed = true; cached = undefined;
      for (const child of probes.keys()) child.kill('SIGKILL');
      await Promise.all([worker.close(), ...probes.values()]);
    },
  };
}
