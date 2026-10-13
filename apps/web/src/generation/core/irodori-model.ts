import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { IRODORI_HEADROOM, IRODORI_MODEL, IRODORI_VOICES, type IrodoriSetupPhase } from '../irodori-contracts';
import { findRepositoryRoot } from './config';
import { IRODORI_RECEPTION_REFERENCES } from './irodori-references';

export interface ModelSpec { id: string; repository: string; revision: string; filename: string; bytes: number; sha256: string }
interface SetupState { phase: IrodoriSetupPhase; downloadedBytes: number; message: string; pid?: number }
interface InstalledModel { schemaVersion: 1; repository: string; filename: string; revision: string; sha256: string; bytes: number; mtimeMs: number; ctimeMs: number }
export interface IrodoriVoice { schemaVersion: 1; path: string; sha256: string; label: string; source: string; license: string; attribution: string; rightsConfirmed: true }
const active = (pid?: number) => { try { if (!pid) return false; process.kill(pid, 0); return true; } catch { return false; } };
async function availableSpace(directory: string) { const disk = await statfs(directory).catch(() => statfs(dirname(directory))); return disk.bavail * disk.bsize; }
async function json<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('Irodoriの保存状態を読めません。', { cause: error }); }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}
async function regularFile(path: string) {
  const file = await lstat(path);
  if (!file.isFile()) throw new Error('Irodori資材には通常のファイルを指定してください。');
  return file;
}
export async function fileHash(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path, { signal });
  for await (const chunk of stream) hash.update(chunk);
  signal?.throwIfAborted();
  return hash.digest('hex');
}

/** No constructor/status method fetches anything. Installation is an explicit operation. */
export class IrodoriModelStore {
  readonly modelPath: string;
  private readonly partPath: string;
  constructor(readonly directory: string, readonly spec: ModelSpec = IRODORI_MODEL, private readonly fetcher: typeof fetch = fetch, private readonly freeSpace: typeof availableSpace = availableSpace, private readonly receptionDirectory?: string) {
    this.modelPath = join(directory, spec.filename);
    this.partPath = `${this.modelPath}.part`;
  }
  private path(name: string) { return join(this.directory, name); }
  async installed(): Promise<boolean> {
    const record = await json<InstalledModel>(this.path('model.json'));
    if (!record || record.schemaVersion !== 1 || record.repository !== this.spec.repository || record.filename !== this.spec.filename || record.sha256 !== this.spec.sha256 || record.revision !== this.spec.revision || record.bytes !== this.spec.bytes) return false;
    try { const file = await regularFile(this.modelPath); return file.size === record.bytes && file.mtimeMs === record.mtimeMs && file.ctimeMs === record.ctimeMs; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async verify(signal?: AbortSignal): Promise<void> {
    if (!await this.installed() || await fileHash(this.modelPath, signal) !== this.spec.sha256) throw new Error('Irodoriモデルの検証に失敗しました。明示セットアップを再実行してください。');
  }
  async status(): Promise<SetupState & { requiredFreeBytes: number; freeBytes?: number }> {
    if (await this.installed()) return { phase: 'ready', downloadedBytes: this.spec.bytes, requiredFreeBytes: IRODORI_HEADROOM, message: 'モデルは検証済みです。' };
    let downloadedBytes = 0;
    try { downloadedBytes = (await regularFile(this.partPath)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const state = await json<SetupState>(this.path('setup-state.json'));
    const interrupted = state && ['downloading', 'verifying'].includes(state.phase) && !active(state.pid);
    let freeBytes: number | undefined;
    try { freeBytes = await this.freeSpace(this.directory); } catch { /* A missing runtime directory is a normal uninstalled state. */ }
    const invalidComplete = state?.phase === 'ready';
    return { phase: interrupted ? 'cancelled' : invalidComplete ? 'failed' : state?.phase ?? 'not-installed', downloadedBytes,
      message: interrupted ? '導入が中断しました。途中から再開できます。' : invalidComplete ? '完成モデルが変更・削除されています。セットアップを再実行してください。' : state?.message ?? 'Irodoriは任意追加です。通常利用では取得しません。',
      requiredFreeBytes: Math.max(0, this.spec.bytes - downloadedBytes) + IRODORI_HEADROOM, ...(freeBytes === undefined ? {} : { freeBytes }) };
  }
  async cancel(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.path('cancel'), '', { mode: 0o600 });
  }
  async install(signal?: AbortSignal, onProgress?: (state: SetupState) => void): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const lockPath = this.path('setup.lock');
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: { pid: number } | undefined;
      try { owner = await json<{ pid: number }>(lockPath); } catch { /* A crash during lock creation can leave incomplete JSON. */ }
      if (!Number.isSafeInteger(owner?.pid) || (owner?.pid ?? 0) <= 0) owner = undefined;
      const fresh = Date.now() - (await lstat(lockPath)).mtimeMs < 30_000;
      if (owner ? active(owner.pid) : fresh) throw new Error('Irodori導入は別の操作で進行中です。直前の中断なら30秒待って再開してください。', { cause: error });
      await rm(lockPath); lock = await open(lockPath, 'wx', 0o600);
    }
    try { await lock.writeFile(JSON.stringify({ pid: process.pid })); }
    catch (error) { await lock.close(); await rm(lockPath, { force: true }); throw new Error('Irodori導入の保存領域を用意できません。空き容量と権限を確認してください。', { cause: error }); }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    // CLI and UI share this cancellation marker and installation lock.
    const timer = setInterval(() => { void lstat(this.path('cancel')).then(abort).catch(() => undefined); }, 100);
    timer.unref();
    let downloadedBytes = 0;
    const state = async (phase: IrodoriSetupPhase, message: string) => {
      const value: SetupState = { phase, downloadedBytes, message, pid: process.pid };
      await atomicJson(this.path('setup-state.json'), value); onProgress?.(value);
    };
    try {
      await rm(this.path('cancel'), { force: true });
      controller.signal.throwIfAborted();
      if (await this.installed()) { await this.verify(controller.signal); downloadedBytes = this.spec.bytes; await state('ready', 'モデルの検証が完了しました。'); return; }
      const identity = { repository: this.spec.repository, filename: this.spec.filename, revision: this.spec.revision, sha256: this.spec.sha256, bytes: this.spec.bytes };
      const partial = await json<typeof identity>(this.path('partial.json'));
      if (!partial || JSON.stringify(partial) !== JSON.stringify(identity)) await rm(this.partPath, { force: true });
      await atomicJson(this.path('partial.json'), identity);
      try { downloadedBytes = (await regularFile(this.partPath)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (downloadedBytes > this.spec.bytes) { await rm(this.partPath); downloadedBytes = 0; }
      if (await this.freeSpace(this.directory) < this.spec.bytes - downloadedBytes + IRODORI_HEADROOM) throw new Error('空き容量が不足しています。途中ファイルを保持しました。容量を確保して再開してください。');
      if (downloadedBytes < this.spec.bytes) {
        await state('downloading', 'モデルを取得しています。取消し後も途中から再開できます。');
        const url = `https://huggingface.co/${this.spec.repository}/resolve/${this.spec.revision}/${this.spec.filename}`;
        const response = await this.fetcher(url, { headers: downloadedBytes ? { Range: `bytes=${downloadedBytes}-` } : {}, signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('取得先へ接続できません。途中ファイルを保持しました。再開してください。');
        if (response.status === 206 && response.headers.get('content-range') !== `bytes ${downloadedBytes}-${this.spec.bytes - 1}/${this.spec.bytes}`) { await response.body.cancel(); throw new Error('取得範囲が固定モデルと一致しません。'); }
        if (response.status !== 200 && response.status !== 206) { await response.body.cancel(); throw new Error('モデル取得の応答が正しくありません。'); }
        if (response.status === 200) downloadedBytes = 0; // A server ignoring Range must not append duplicate bytes.
        const destination = await open(this.partPath, downloadedBytes ? 'a' : 'w', 0o600);
        const reader = response.body.getReader();
        let reportedAt = 0;
        try {
          for (;;) {
            controller.signal.throwIfAborted();
            const next = await reader.read(); if (next.done) break;
            if (downloadedBytes + next.value.length > this.spec.bytes) throw new Error('モデルの容量が固定情報と一致しません。');
            await destination.writeFile(next.value); downloadedBytes += next.value.length;
            if (Date.now() - reportedAt > 150) { await state('downloading', 'モデルを取得しています。'); reportedAt = Date.now(); }
          }
          await destination.sync();
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); await destination.close(); }
      }
      await state('verifying', '取得したモデルを検証しています。');
      if (downloadedBytes !== this.spec.bytes) throw new Error('取得が途中で終わりました。再開してください。');
      if (await fileHash(this.partPath, controller.signal) !== this.spec.sha256) {
        await rm(this.partPath); downloadedBytes = 0;
        throw new Error('チェックサムが一致しません。完成資材には採用しません。再試行で取得し直します。');
      }
      controller.signal.throwIfAborted();
      await rename(this.partPath, this.modelPath);
      const file = await regularFile(this.modelPath);
      await atomicJson(this.path('model.json'), { schemaVersion: 1, ...identity, mtimeMs: file.mtimeMs, ctimeMs: file.ctimeMs } satisfies InstalledModel);
      await rm(this.path('partial.json'), { force: true });
      await state('ready', 'モデルの検証が完了しました。');
    } catch (error) {
      await state(controller.signal.aborted ? 'cancelled' : 'failed', controller.signal.aborted ? '導入を取り消しました。途中から再開できます。' : error instanceof Error ? error.message : '導入に失敗しました。');
      throw error;
    } finally { clearInterval(timer); signal?.removeEventListener('abort', abort); await lock.close(); await rm(lockPath, { force: true }); }
  }
  async receptionVoices(): Promise<Array<IrodoriVoice & { id: string }>> {
    const directory = this.receptionDirectory ?? join(await findRepositoryRoot(), 'assets', 'irodori');
    return Promise.all(IRODORI_RECEPTION_REFERENCES.map(async reference => {
      const path = join(directory, reference.filename);
      const file = await regularFile(path);
      if (file.size < 8 || file.size > 64 * 1024 * 1024 || await fileHash(path) !== reference.sha256) throw new Error('受付声の固定参照を確認できません。Ripolaの同梱資材を復元して起動し直してください。');
      const preset = IRODORI_VOICES.find(value => value.id === reference.id)!;
      return { schemaVersion: 1, id: reference.id, path, sha256: reference.sha256, label: preset.name, source: 'Ripola受付声オーディション（合成音声）', license: 'MIT; assets/irodori/provenance.json', attribution: '音声：Irodori-TTS v4.1 Small · 合成音声', rightsConfirmed: true };
    })).catch(error => { throw new Error('受付声の固定参照を確認できません。Ripolaの同梱資材を復元して起動し直してください。', { cause: error }); });
  }
  async voice(): Promise<IrodoriVoice | undefined> {
    const voice = await json<IrodoriVoice>(this.path('voice.json'));
    if (!voice) return;
    if (voice.schemaVersion !== 1 || !isAbsolute(voice.path) || !voice.path.endsWith('.gguf') || voice.rightsConfirmed !== true || !/^[a-f0-9]{64}$/.test(voice.sha256)
      || ![voice.label, voice.source, voice.license, voice.attribution].every(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 500)) throw new Error('権利確認済みvoiceの登録情報が正しくありません。');
    let file;
    try { file = await regularFile(voice.path); }
    catch (error) { throw new Error('固定voice資材を読めません。登録したファイルを確認してください。', { cause: error }); }
    if (file.size < 8 || file.size > 64 * 1024 * 1024 || await fileHash(voice.path) !== voice.sha256) throw new Error('固定voice資材が登録時から変わっています。権利と資材を再確認してください。');
    return voice;
  }
  async registerVoice(input: Omit<IrodoriVoice, 'schemaVersion' | 'sha256'>): Promise<void> {
    if (!isAbsolute(input.path) || !input.path.endsWith('.gguf') || input.rightsConfirmed !== true || ![input.label, input.source, input.license, input.attribution].every(value => value?.trim() && value.length <= 500)) throw new Error('既存voiceの絶対path、取得元、条件、帰属、明示的な権利確認が必要です。');
    const file = await regularFile(input.path);
    if (file.size < 8 || file.size > 64 * 1024 * 1024) throw new Error('voice資材の容量が正しくありません。');
    const handle = await open(input.path, 'r');
    try { const magic = Buffer.alloc(4); await handle.read(magic, 0, 4, 0); if (magic.toString() !== 'GGUF') throw new Error('既存GGUF voice資材を指定してください。'); } finally { await handle.close(); }
    await mkdir(this.directory, { recursive: true });
    await atomicJson(this.path('voice.json'), { schemaVersion: 1, ...input, sha256: await fileHash(input.path) } satisfies IrodoriVoice);
  }
}
