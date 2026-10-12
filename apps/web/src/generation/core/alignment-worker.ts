import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout, clearTimeout } from 'node:timers';
import type { AlignmentRuntimeRequest, AlignmentRuntimeResult } from './alignment-adapter';
import { validateAlignmentResult } from './alignment-projection';
import { AlignmentFrameDecoder, MAX_ALIGNMENT_REQUEST_BYTES } from './alignment-worker-protocol';
import { trackNativeProcess } from './native-processes';

export class AlignmentWorkerError extends Error {
  constructor(readonly code: 'cancelled' | 'timeout' | 'crashed' | 'protocol' | 'closed' | 'queue-full' | 'input' | 'runtime' | 'resources-changed', message: string) { super(message); this.name = 'AlignmentWorkerError'; }
}
interface Pending {
  id: string; request: AlignmentRuntimeRequest; frame: string; signal: AbortSignal;
  resolve: (result: AlignmentRuntimeResult) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>; abort: () => void; finished: boolean;
}
interface Session {
  child: ChildProcessWithoutNullStreams; identity: string; decoder: AlignmentFrameDecoder;
  ready: Promise<void>; readyResolve: () => void; readyReject: (error: Error) => void;
  closed: Promise<void>; closeResolve: () => void;
  readySeen: boolean; awaiting: boolean; stopping: boolean; stderrBytes: number;
}
export interface AlignmentWorkerOptions {
  command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; alignerVersion: string;
  /** Check existing resources before spawning. A changed identity replaces an idle worker. */
  prepare: () => Promise<string>;
  onStopped?: () => void;
  timeoutMs?: number; maxPending?: number; killGraceMs?: number;
}

function killTree(child: ChildProcess, signal: NodeJS.Signals, grouped = true): void {
  try {
    if (grouped && process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Readiness probes have no detached group; still reap their direct child.
    try { child.kill(signal); } catch { /* Already exited. */ }
  }
}

export function trackAlignmentProcess(child: ChildProcess, grouped = true): () => void {
  return trackNativeProcess(child, grouped);
}
function reference(session: Session, active: boolean): void {
  for (const stream of [session.child.stdin, session.child.stdout, session.child.stderr]) {
    // Child pipe streams are sockets at runtime; public stream types omit ref/unref.
    const socket = stream as typeof stream & { ref?: () => void; unref?: () => void };
    if (active) socket.ref?.(); else socket.unref?.();
  }
}

/** One model, one in-flight request, bounded FIFO. Failed requests are never replayed. */
export class AlignmentWorker {
  private queue: Pending[] = [];
  private active?: Pending;
  private session?: Session;
  private pumping = false;
  private stopping?: Promise<void>;
  private disposed = false;
  constructor(private readonly options: AlignmentWorkerOptions) {}

  readyFor(identity: string): boolean {
    return !this.disposed && !!this.session && !this.session.stopping && this.session.readySeen && this.session.identity === identity;
  }

  align(request: AlignmentRuntimeRequest, signal: AbortSignal): Promise<AlignmentRuntimeResult> {
    if (this.disposed) return Promise.reject(new AlignmentWorkerError('closed', 'alignment workerは終了済みです。'));
    if (signal.aborted) return Promise.reject(new AlignmentWorkerError('cancelled', 'alignmentを中断しました。'));
    if (this.queue.length + Number(!!this.active) >= (this.options.maxPending ?? 8)) return Promise.reject(new AlignmentWorkerError('queue-full', 'alignmentの待機数が上限です。完了後に新しい要求を送ってください。'));
    const id = randomUUID();
    let frame: string;
    try {
      frame = JSON.stringify({ protocolVersion: 1, type: 'align', id, request }) + '\n';
      if (Buffer.byteLength(frame) > MAX_ALIGNMENT_REQUEST_BYTES) throw new Error();
    } catch { return Promise.reject(new AlignmentWorkerError('input', 'alignment入力が大きすぎるか形式が正しくありません。')); }
    return new Promise((resolve, reject) => {
      const pending: Pending = { id, request, frame, signal, resolve, reject, finished: false,
        timer: setTimeout(() => this.cancel(pending, new AlignmentWorkerError('timeout', 'alignmentが待機・実行時間の上限を超えました。結果を採用していません。')), this.options.timeoutMs ?? 300_000),
        abort: () => this.cancel(pending, new AlignmentWorkerError('cancelled', 'alignmentを中断しました。')) };
      signal.addEventListener('abort', pending.abort, { once: true });
      this.queue.push(pending);
      void this.pump();
    });
  }
  private finish(pending: Pending, error?: Error, result?: AlignmentRuntimeResult): void {
    if (pending.finished) return;
    pending.finished = true; clearTimeout(pending.timer); pending.signal.removeEventListener('abort', pending.abort);
    if (error) pending.reject(error); else pending.resolve(result!);
  }
  private cancel(pending: Pending, error: Error): void {
    if (pending.finished) return;
    if (pending === this.active) { void this.fail(error); return; }
    this.queue = this.queue.filter(item => item !== pending);
    this.finish(pending, error);
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.active || this.stopping || this.disposed || !this.queue.length) return;
    this.pumping = true;
    const pending = this.queue.shift()!; this.active = pending;
    try {
      const identity = await this.options.prepare();
      if (pending.finished || this.stopping || this.disposed) return;
      if (this.session && this.session.identity !== identity) await this.terminate(this.session);
      if (pending.finished || this.stopping || this.disposed) return;
      const session = this.session ?? this.start(identity);
      reference(session, true);
      await session.ready;
      if (pending.finished || session.stopping || this.disposed) return;
      session.stderrBytes = 0; session.awaiting = true;
      session.child.stdin.write(pending.frame);
    } catch {
      if (!pending.finished && !this.stopping) await this.fail(new AlignmentWorkerError('runtime', 'alignment runtimeまたは既存モデルを確認できませんでした。音声を保持しました。'));
    } finally { this.pumping = false; void this.pump(); }
  }
  private start(identity: string): Session {
    const child = spawn(this.options.command, this.options.args, { cwd: this.options.cwd, env: this.options.env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let readyResolve!: () => void, readyReject!: (error: Error) => void, closeResolve!: () => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const closed = new Promise<void>(resolve => { closeResolve = resolve; });
    const session: Session = { child, identity, decoder: new AlignmentFrameDecoder(), ready, readyResolve, readyReject, closed, closeResolve, readySeen: false, awaiting: false, stopping: false, stderrBytes: 0 };
    this.session = session;
    const unregister = trackAlignmentProcess(child);
    child.unref();
    child.stdout.on('data', (part: Buffer) => this.receive(session, part));
    child.stderr.on('data', (part: Buffer) => {
      if (session.stopping || session !== this.session) return;
      session.stderrBytes += part.length;
      if (session.stderrBytes > 1024 * 1024) void this.fail(new AlignmentWorkerError('protocol', 'alignment診断出力が上限を超えました。'));
    });
    const failed = () => { if (session.stopping || session !== this.session) return; void this.fail(new AlignmentWorkerError('crashed', 'alignment workerが停止しました。結果を採用せず、要求を再送していません。')); };
    child.on('error', failed); child.stdin.on('error', failed);
    child.on('close', () => {
      unregister(); session.closeResolve();
      if (!session.stopping) failed();
    });
    return session;
  }
  private receive(session: Session, part: Buffer): void {
    if (session.stopping || session !== this.session) return;
    try {
      const frames = session.decoder.push(part);
      let response: AlignmentRuntimeResult | Error | undefined;
      for (const frame of frames) {
        if (frame.type === 'ready') {
          if (session.readySeen || session.awaiting || frame.alignerVersion !== this.options.alignerVersion) throw new Error();
          session.readySeen = true;
        } else {
          if (!session.readySeen || !session.awaiting || !this.active || frame.id !== this.active.id || response) throw new Error();
          if (frame.type === 'error') {
            response = new AlignmentWorkerError(frame.code === 'resources-changed' ? 'resources-changed' : 'runtime', 'alignment処理に失敗しました。結果を採用していません。');
          } else {
            validateAlignmentResult(frame.result, this.active.request, frame.result?.durationSeconds);
            response = frame.result;
          }
        }
      }
      // Another response cannot legitimately follow before the next input is sent.
      if (response && session.decoder.incomplete) throw new Error();
      if (response instanceof AlignmentWorkerError && response.code === 'resources-changed') { void this.fail(response); return; }
      if (response) {
        session.awaiting = false;
        const pending = this.active!; this.active = undefined;
        reference(session, false);
        this.finish(pending, response instanceof Error ? response : undefined, response instanceof Error ? undefined : response);
        void this.pump();
      } else if (session.readySeen) session.readyResolve();
    } catch { void this.fail(new AlignmentWorkerError('protocol', 'alignment応答のframe・要求ID・本文・時刻が正しくありません。結果を採用していません。')); }
  }
  private async terminate(session: Session): Promise<void> {
    session.stopping = true;
    session.readyReject(new AlignmentWorkerError('closed', 'alignment workerを終了しました。'));
    reference(session, true);
    killTree(session.child, 'SIGTERM');
    const deadline = setTimeout(() => killTree(session.child, 'SIGKILL'), this.options.killGraceMs ?? 1000);
    await session.closed;
    clearTimeout(deadline); killTree(session.child, 'SIGKILL'); // Include decoder subprocesses.
    if (this.session === session) this.session = undefined;
    this.options.onStopped?.();
  }
  private fail(error: Error): Promise<void> {
    if (this.stopping) return this.stopping;
    const active = this.active;
    const queued = this.queue.splice(0);
    for (const pending of queued) this.finish(pending, error);
    const session = this.session;
    this.stopping = (async () => {
      if (session) await this.terminate(session);
      if (active) this.finish(active, error);
      if (this.active === active) this.active = undefined;
    })().finally(() => { this.stopping = undefined; void this.pump(); });
    return this.stopping;
  }
  async close(): Promise<void> {
    this.disposed = true;
    await this.fail(new AlignmentWorkerError('closed', 'alignment workerを終了しました。未完了の結果を採用していません。'));
  }
}
