import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

export function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function validId(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value); }
export function requireId(value: unknown): string { if (!validId(value)) throw new Error('IDが正しくありません。'); return value; }
export function requireKey(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('音声IDが正しくありません。'); return value; }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
export function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }

export class LibraryDisk {
  constructor(readonly root: string) {}
  private async safe(parts: string[]): Promise<string> {
    for (const part of parts) if (!/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..') throw new Error('保存IDが正しくありません。');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('保存先にsymlinkは使用できません。');
    const root = await realpath(this.root);
    let candidate = root;
    for (const part of parts) {
      candidate = join(candidate, part);
      try {
        if ((await lstat(candidate)).isSymbolicLink()) throw new Error('保存先にsymlinkは使用できません。');
        const path = await realpath(candidate);
        const rel = relative(root, path);
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('保存先の範囲外です。');
      } catch (error) { if (!missing(error)) throw error; }
    }
    return candidate;
  }
  async existingPath(parts: string[]): Promise<string> {
    const path = await this.safe(parts);
    if (!(await lstat(path)).isFile()) throw new Error('保存ファイルが見つかりません。');
    return path;
  }
  async readBytes(parts: string[]): Promise<Uint8Array | undefined> {
    try { return await readFile(await this.safe(parts)); } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  async read<T>(parts: string[]): Promise<T | undefined> {
    const bytes = await this.readBytes(parts);
    return bytes ? JSON.parse(Buffer.from(bytes).toString('utf8')) as T : undefined;
  }
  async write(parts: string[], value: unknown): Promise<void> { await this.writeBytes(parts, new TextEncoder().encode(JSON.stringify(value))); }
  async writeBytes(parts: string[], value: Uint8Array): Promise<void> {
    const destination = await this.safe(parts);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    // Recheck after directory creation. Use exclusive private temporary files, then atomic rename.
    await this.safe(parts);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, destination);
  }
  async list(directory: string): Promise<string[]> {
    try { return (await readdir(await this.safe([directory]))).filter((name) => /^[a-zA-Z0-9_-]+\.json$/.test(name)); }
    catch (error) { if (missing(error)) return []; throw error; }
  }
  /** Same-library reversible move; never overwrites an existing destination. */
  async move(source: string[], destination: string[]): Promise<void> {
    const from = await this.existingPath(source);
    const to = await this.safe(destination);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await this.safe(destination);
    try { await lstat(to); throw new Error('移動先に既存ファイルがあります。'); }
    catch (error) { if (!missing(error)) throw error; }
    await rename(from, to);
  }
  /** Only a verified intermediate may be removed; source hash and symlinks are checked. */
  async removeVerified(parts: string[], hash: string): Promise<void> {
    requireKey(hash);
    const path = await this.existingPath(parts);
    if (digest(await readFile(path)) !== hash) throw new Error('削除前の元音声のhashが一致しません。');
    await unlink(path);
  }
  async lock(id: string): Promise<(() => Promise<void>) | undefined> {
    requireId(id);
    const path = await this.safe(['locks', `${id}.lock`]);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(path, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
        await handle.sync(); await handle.close();
        return async () => { await unlink(path).catch((error) => { if (!missing(error)) throw error; }); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let owner: { pid: number };
        try { owner = JSON.parse(await readFile(path, 'utf8')) as { pid: number }; } catch { return undefined; }
        if (Number.isInteger(owner.pid) && processAlive(owner.pid)) return undefined;
        await unlink(path).catch((error) => { if (!missing(error)) throw error; });
      }
    }
    return undefined;
  }
  async withLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    let release = await this.lock(id);
    for (let attempt = 0; !release && attempt < 100; attempt++) { await pause(10); release = await this.lock(id); }
    if (!release) throw new Error('別の処理が操作中です。少し待って再試行してください。');
    try { return await action(); } finally { await release(); }
  }
}
