import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { DEFAULT_IRODORI_SETTINGS, type IrodoriSettings, type IrodoriStatus } from '../irodori-contracts';
import { findRepositoryRoot } from './config';
import { IrodoriModelStore, atomicJson } from './irodori-model';
import { detectSpeechExecutable, IrodoriRuntime, irodoriSettings } from './irodori-runtime';

export class IrodoriController {
  private installation?: Promise<void>;
  readonly runtime: IrodoriRuntime;
  constructor(readonly store: IrodoriModelStore, executable?: string) { this.runtime = new IrodoriRuntime(store, executable); }
  async status(): Promise<IrodoriStatus> {
    let voice; let voiceMessage;
    try { voice = await this.store.voice(); } catch { voiceMessage = '固定voiceの資材を確認できません。登録した資材と権利条件を再確認してください。'; }
    const state = await this.store.status();
    const executableAvailable = Boolean(await detectSpeechExecutable(this.runtime.executable));
    return { ...state, totalBytes: this.store.spec.bytes, executableAvailable, voiceAvailable: Boolean(voice), runtime: this.runtime.status,
      message: voiceMessage ?? (state.phase === 'ready' ? !executableAvailable ? 'speech.cppが未導入です。ガイドから実行環境を用意してください。' : !voice ? 'モデルは導入済みです。権利確認済みの固定voiceを登録すると利用できます。' : this.runtime.status === 'running' ? 'IrodoriはこのPCで利用できます。' : this.runtime.status === 'starting' ? 'このPCでモデルと固定voiceを読み込んでいます。' : this.runtime.status === 'failed' ? 'Irodoriの起動・動作に失敗しました。実行環境とvoiceを確認して起動を再試行してください。' : 'このPCで起動すると利用できます。' : state.message),
      ...(voice ? { voiceLabel: voice.label, voiceAttribution: voice.attribution } : {}) };
  }
  async install(): Promise<void> {
    if (this.installation) return;
    // Publish progress on disk; the browser never owns the download lifetime.
    this.installation = this.store.install().catch(() => undefined).finally(() => { this.installation = undefined; });
    // Yield until the lock/state has been written, without holding the RPC open.
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
  async settings(): Promise<IrodoriSettings> {
    try {
      const contents = await readFile(join(this.store.directory, 'settings.json'), 'utf8');
      if (contents.length > 8192) throw new Error('Irodori設定が大きすぎます。');
      return irodoriSettings(JSON.parse(contents));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_IRODORI_SETTINGS }; throw new Error('Irodori設定を読めません。', { cause: error }); }
  }
  async saveSettings(input: IrodoriSettings): Promise<void> {
    const settings = irodoriSettings(input);
    // Setups create the private directory; settings are available after installation.
    if (!await this.store.installed()) throw new Error('モデルを導入してから設定を保存してください。');
    await atomicJson(join(this.store.directory, 'settings.json'), settings);
  }
}
const controllerKey = Symbol.for('ripola.irodori-controller.v1');
const controllers = globalThis as typeof globalThis & { [controllerKey]?: Promise<IrodoriController> };
export function getIrodoriController(): Promise<IrodoriController> {
  return controllers[controllerKey] ??= (async () => {
    const root = await findRepositoryRoot();
    let fileEnv: Record<string, string | undefined> = {};
    try { const contents = await readFile(join(root, '.env.local'), 'utf8'); if (contents.length > 64 * 1024) throw new Error('設定が大きすぎます。'); fileEnv = parseEnv(contents); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Irodoriの設定を読めません。', { cause: error }); }
    return new IrodoriController(new IrodoriModelStore(join(root, '.reader-data', 'irodori')), process.env.RSVP_IRODORI_EXECUTABLE ?? fileEnv.RSVP_IRODORI_EXECUTABLE);
  })();
}
