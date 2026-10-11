import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { DEFAULT_IRODORI_SETTINGS, IRODORI_LIMITS, type IrodoriSettings } from '../irodori-contracts';
import { fileHash, IrodoriModelStore, type IrodoriVoice } from './irodori-model';
import { wavDuration } from './providers';

export async function detectSpeechExecutable(configured?: string): Promise<string | undefined> {
  if (configured && !isAbsolute(configured)) throw new Error('speech実行ファイルは絶対pathで指定してください。');
  const candidates = configured ? [configured] : [...(process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(path => join(path, 'speech')), join(homedir(), '.local', 'bin', 'speech')];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate; } catch { /* Continue through only known executable locations. */ }
  }
}
export function irodoriSettings(input: Partial<IrodoriSettings> = {}): IrodoriSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['steps', 'speed', 'seed', 'instructions'].includes(key))) throw new Error('Irodori合成設定の形式が正しくありません。');
  const settings = { ...DEFAULT_IRODORI_SETTINGS, ...input };
  if (!Number.isInteger(settings.steps) || settings.steps < 1 || settings.steps > 16 || !Number.isFinite(settings.speed) || settings.speed < .25 || settings.speed > 4
    || !Number.isSafeInteger(settings.seed) || settings.seed < 0 || typeof settings.instructions !== 'string' || [...settings.instructions].length > 256) throw new Error('Irodori設定はsteps 1〜16、速度0.25〜4、非負整数seed、指示256文字以内にしてください。');
  return settings;
}
export interface NativeModel { id: string; version: string; speech: { name: string; architecture: string; task: string; sample_rate: number; file_bytes: number; weight_type: string; max_text_tokens: number; voices: Array<{ name: string }>; device?: string; threads?: number; layout?: number } }
export interface NativeSession { endpoint: string; model: NativeModel; modelHash: string; voiceHash: string; binaryHash: string; voice: string }
const identityHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function irodoriFingerprint(session: NativeSession, settings: IrodoriSettings): string {
  const { id, version, speech } = session.model;
  // OpenAI's model wrapper also has a created timestamp; it is not synthesis identity.
  const model = { id, version, architecture: speech.architecture, layout: speech.layout, device: speech.device, threads: speech.threads, sampleRate: speech.sample_rate };
  return `speech.cpp-irodori-v1:${identityHash({ model, modelHash: session.modelHash, voiceHash: session.voiceHash, binaryHash: session.binaryHash, voice: session.voice, settings: irodoriSettings(settings) })}`;
}
function localEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Irodori native endpointはこのPCのloopbackに限定します。');
  return url.origin;
}
async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) throw new Error('Irodoriの応答がありません。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > maximum) throw new Error('Irodoriの応答が上限を超えています。'); chunks.push(item.value); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
export async function nativeModel(endpoint: string, store: IrodoriModelStore): Promise<NativeModel> {
  const response = await fetch(`${localEndpoint(endpoint)}/v1/models`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('Irodori runtimeのモデルを確認できません。');
  const value = JSON.parse(Buffer.from(await boundedBytes(response, 128 * 1024)).toString('utf8')) as { data?: NativeModel[] };
  const model = value.data?.find(value => value.speech?.architecture === 'irodori-tts');
  if (!model || typeof model.id !== 'string' || !/^[\w.+-]{1,200}$/.test(model.id) || typeof model.version !== 'string' || !/^0\.8\.\d+$/.test(model.version) || Number(model.version.split('.')[2]) < 3
    || model.speech.task !== 'synthesis' || model.speech.sample_rate !== 48000 || model.speech.file_bytes !== store.spec.bytes || model.speech.weight_type !== 'F16'
    || !model.speech.name.includes('-MF') || model.speech.max_text_tokens !== IRODORI_LIMITS.maxTextTokens || !model.speech.voices?.some(voice => voice.name === 'ripola')) throw new Error('Irodori MFモデル・固定voice・対応speech.cpp（0.8.3以降の0.8系）の組合せを確認できません。');
  return model;
}

/** Sends the actual documented HTTP request. Abort disconnects the native request. */
export async function synthesizeIrodori(session: NativeSession, text: string, settings: IrodoriSettings, signal?: AbortSignal): Promise<Uint8Array> {
  const endpoint = localEndpoint(session.endpoint);
  const normalized = irodoriSettings(settings);
  if (session.voice !== 'ripola' || !/^[a-f0-9]{64}$/.test(session.voiceHash)) throw new Error('固定voiceがありません。チャンクごとに声が変わる可能性があるため生成を開始できません。');
  if (!text.trim() || [...text].length > IRODORI_LIMITS.recommendedMaxCharacters) throw new Error('Irodoriは短いチャンクに分けてください（推奨上限90文字、最大256 tokens/30秒）。');
  const response = await fetch(`${endpoint}/v1/audio/speech`, { method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: session.model.id, input: text, voice: session.voice, response_format: 'wav', language: 'ja', ...normalized }) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Irodori合成が失敗しました（HTTP ${response.status}）。長さとruntimeを確認してください。`); }
  if (response.headers.get('x-speech-stop') !== 'complete' || response.headers.get('x-sample-rate') !== '48000' || response.headers.get('x-speech-seed') !== String(normalized.seed)) {
    await response.body?.cancel(); throw new Error('Irodoriの音声は完了を確認できません。切れた音声を完成扱いにはしません。');
  }
  const bytes = await boundedBytes(response, 4 * 1024 * 1024);
  signal?.throwIfAborted();
  const duration = wavDuration(bytes);
  const buffer = Buffer.from(bytes);
  let validFormat = false; let audible = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = buffer.readUInt32LE(offset + 4); const begin = offset + 8; const type = buffer.toString('ascii', offset, offset + 4);
    if (type === 'fmt ') validFormat = buffer.readUInt16LE(begin + 2) === 1 && buffer.readUInt32LE(begin + 4) === 48000;
    if (type === 'data') { if (size % 2) throw new Error('Irodori PCM音声が途中で切れています。'); for (let at = begin; at + 2 <= begin + size; at += 2) if (Math.abs(buffer.readInt16LE(at)) > 16) { audible = true; break; } }
    offset = begin + size + size % 2;
  }
  if (!validFormat || !audible || duration > IRODORI_LIMITS.maxAudioSeconds + .01) throw new Error('Irodori音声の形式・無音・長さの検査に失敗しました。');
  return bytes;
}

/** Only this instance's child is signalled. Constructors/status never start it. */
export class IrodoriRuntime {
  private child?: ChildProcess;
  private session?: NativeSession;
  private starting?: Promise<void>;
  private launchController?: AbortController;
  private state: 'stopped' | 'starting' | 'running' | 'failed' = 'stopped';
  private shutdown = () => { this.child?.kill('SIGTERM'); };
  private signalShutdown = (signal: NodeJS.Signals) => {
    this.shutdown(); this.removeShutdownListeners();
    // Preserve existing server handlers; restore Node's default only when we added the sole handler.
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  private removeShutdownListeners() {
    process.off('exit', this.shutdown); process.off('SIGINT', this.signalShutdown); process.off('SIGTERM', this.signalShutdown);
  }
  constructor(readonly store: IrodoriModelStore, readonly executable?: string) {}
  get status() { return this.state; }
  current(): NativeSession {
    if (!this.session || !this.child || this.child.exitCode !== null || this.child.signalCode !== null || this.state !== 'running') throw new Error('Irodori runtimeは停止中です。設定画面で「このPCで起動」を押してください。');
    return this.session;
  }
  async start(): Promise<void> {
    if (this.state === 'running') return;
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async launch(): Promise<void> {
    this.state = 'starting';
    const controller = new AbortController(); this.launchController = controller;
    try {
      const executable = await detectSpeechExecutable(this.executable);
      if (!executable) throw new Error('speech実行ファイルが見つかりません。Irodoriガイドに沿ってspeech.cppを用意してください。');
      await this.store.verify(controller.signal);
      const voice: IrodoriVoice | undefined = await this.store.voice();
      if (!voice) throw new Error('権利確認済みの固定voiceが未登録です。ガイドに沿って既存voice資材を登録してください。');
      const binaryHash = await fileHash(executable, controller.signal);
      controller.signal.throwIfAborted();
      // Absolute filenames never trigger speech.cpp's catalog auto-download.
      const child = spawn(executable, ['serve', this.store.modelPath, '--add-voice', `ripola=${voice.path}`, '--host', '127.0.0.1', '--port', '0'], {
        shell: false, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: homedir(), LANG: 'en_US.UTF-8' },
      });
      this.child = child; process.once('exit', this.shutdown); process.once('SIGINT', this.signalShutdown); process.once('SIGTERM', this.signalShutdown);
      const endpoint = await new Promise<string>((resolve, reject) => {
        let tail = ''; const timer = setTimeout(() => { cleanup(); reject(new Error('Irodori runtimeの起動が時間内に完了しませんでした。')); }, 120_000);
        const cleanup = () => { clearTimeout(timer); child.stderr?.off('data', data); child.off('error', error); child.off('exit', exited); };
        const error = () => { cleanup(); reject(new Error('speech実行ファイルを起動できません。')); };
        const exited = () => { cleanup(); reject(new Error('Irodori runtimeが起動前に終了しました。モデル・voice・実行環境を確認してください。')); };
        const data = (chunk: Buffer) => { tail = (tail + chunk.toString('utf8')).slice(-4096); const match = tail.match(/speech serve: speech\.cpp [\w.-]+, listening on (http:\/\/127\.0\.0\.1:\d+)/); if (match) { cleanup(); resolve(match[1]); } };
        child.stderr?.on('data', data); child.once('error', error); child.once('exit', exited);
      });
      child.stderr?.resume();
      child.on('error', () => { this.state = 'failed'; this.session = undefined; });
      child.once('exit', () => { this.removeShutdownListeners(); if (this.child === child) { this.child = undefined; this.session = undefined; if (this.state !== 'stopped') this.state = 'failed'; } });
      const model = await nativeModel(endpoint, this.store);
      controller.signal.throwIfAborted();
      if (this.child !== child || child.exitCode !== null || child.signalCode !== null) throw new Error('Irodori runtimeが起動確認中に終了しました。');
      this.session = { endpoint, model, modelHash: this.store.spec.sha256, voiceHash: voice.sha256, binaryHash, voice: 'ripola' };
      this.state = 'running';
    } catch (error) { await this.stop(); this.state = 'failed'; throw error; }
  }
  async stop(): Promise<void> {
    this.state = 'stopped'; this.session = undefined;
    this.launchController?.abort();
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      for (let attempt = 0; attempt < 40 && child.exitCode === null && child.signalCode === null; attempt++) await pause(50);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise<void>(resolve => child.once('exit', () => resolve())); }
    }
    this.removeShutdownListeners(); this.child = undefined;
  }
}
