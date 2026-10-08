import { setTimeout, clearTimeout } from 'node:timers';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
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
}

function safeChildEnv(modelDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'OMP_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, RSVP_ALIGNMENT_MODEL_DIR: modelDir, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false', PYTHONDONTWRITEBYTECODE: '1' };
}
export function pythonAlignmentAdapter(config: GenerationServerConfig): AlignmentAdapter {
  const version = config.alignmentVersion ?? 'reazon-rs35kh-46afc596-ctc-v2';
  let cached: { until: number; result: Promise<{ status: 'ready' | 'setup-required' | 'failed'; message: string }> } | undefined;
  const readiness = async () => {
    if (cached && cached.until > Date.now()) return cached.result;
    const result = (async (): Promise<{ status: 'ready' | 'setup-required' | 'failed'; message: string }> => {
      if (!config.alignmentPython || !config.alignmentScript || !config.alignmentModelDir) return { status: config.alignmentSetupState === 'failed' ? 'failed' : 'setup-required', message: 'リポジトリのフォルダーで pnpm setup:audio を実行し、完了後 pnpm dev を起動してください。' };
      try {
        if (![config.alignmentPython, config.alignmentScript, config.alignmentModelDir].every(isAbsolute) || version !== 'reazon-rs35kh-46afc596-ctc-v2') throw new Error();
        await access(config.alignmentPython, constants.X_OK); await access(config.alignmentScript, constants.R_OK);
        if (!(await stat(config.alignmentModelDir)).isDirectory()) throw new Error();
        const check = config.alignmentCheckScript ?? `${dirname(config.alignmentScript)}/check-alignment-runtime.py`;
        await promisify(execFile)(config.alignmentPython, [check, '--model-dir', config.alignmentModelDir], { env: safeChildEnv(config.alignmentModelDir), timeout: 30_000, maxBuffer: 64 * 1024 });
        return { status: 'ready', message: '新しい音声を保存した後に、このPCで時刻を自動補正します。' };
      } catch { return { status: 'failed', message: 'Python・依存・モデル・ffmpegの確認に失敗しました。pnpm setup:audio を再実行し、起動中なら pnpm dev を再起動してください。' }; }
    })();
    cached = { until: Date.now() + 30_000, result }; return result;
  };
  return {
    version,
    async available() { return (await readiness()).status === 'ready'; },
    readiness,
    async align(request, signal) {
      if (!await this.available()) throw new Error('ローカルalignment runtimeまたはモデルが未設定です。音声の再合成は行いません。');
      if (signal.aborted) throw new Error('alignmentを中断しました。');
      return new Promise<AlignmentRuntimeResult>((resolve, reject) => {
        // Only server configuration supplies executable/script/model paths. No shell or browser argv.
        const child = spawn(config.alignmentPython!, [config.alignmentScript!], {
          cwd: dirname(config.alignmentScript!), shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: safeChildEnv(config.alignmentModelDir!),
        });
        let output = '';
        let stderrBytes = 0;
        let settled = false;
        let killDeadline: ReturnType<typeof setTimeout> | undefined;
        const stop = () => { child.kill('SIGTERM'); killDeadline ??= setTimeout(() => child.kill('SIGKILL'), 1000); };
        const deadline = setTimeout(stop, 5 * 60 * 1000);
        const finish = (error?: Error, result?: AlignmentRuntimeResult) => {
          if (settled) return; settled = true;
          clearTimeout(deadline); signal.removeEventListener('abort', stop);
          if (error) reject(error); else resolve(result!);
        };
        signal.addEventListener('abort', stop, { once: true });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (part: string) => {
          if (settled) return;
          output += part;
          if (Buffer.byteLength(output) > 4 * 1024 * 1024) { stop(); finish(new Error('alignment応答が大きすぎます。')); }
        });
        // Consume diagnostics without logging raw transcript, paths, env or credentials.
        child.stderr.on('data', (part: Buffer) => { stderrBytes += part.length; if (stderrBytes > 1024 * 1024) stop(); });
        child.on('error', () => finish(new Error('alignment runtimeを起動できませんでした。')));
        child.stdin.on('error', () => finish(new Error('alignment入力の送信に失敗しました。')));
        child.on('close', (code) => {
          if (killDeadline) clearTimeout(killDeadline);
          if (signal.aborted) { finish(new Error('alignmentを中断しました。')); return; }
          if (code !== 0) { finish(new Error('alignment runtimeが失敗しました。保存済み音声を保持しました。')); return; }
          try { finish(undefined, JSON.parse(output) as AlignmentRuntimeResult); }
          catch { finish(new Error('alignment応答の形式が正しくありません。')); }
        });
        child.stdin.end(JSON.stringify(request));
      });
    },
  };
}
