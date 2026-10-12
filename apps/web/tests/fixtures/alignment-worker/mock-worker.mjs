import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const log = process.argv[2];
const record = value => appendFileSync(log, JSON.stringify(value) + '\n');
const send = value => process.stdout.write(JSON.stringify({ protocolVersion: 1, ...value }) + '\n');
const semantics = { method: 'forced-alignment', confidenceMeaning: 'transcript-conditioned-ctc' };
record({ type: 'spawn', pid: process.pid });
record({ type: 'load' });
process.stderr.write('mock model loaded\n');
setTimeout(() => send({ type: 'ready', alignerVersion: 'pinned', ...semantics }), Number(process.argv[3] ?? 0));
createInterface({ input: process.stdin }).on('line', async line => {
  const { id, request } = JSON.parse(line);
  const mode = request.spokenText;
  record({ type: 'request', id, text: request.normalizedText, mode });
  if (mode === 'crash') process.exit(2);
  if (mode === 'hang' || mode === 'descendant') {
    process.on('SIGTERM', () => {});
    if (mode === 'descendant') {
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      record({ type: 'descendant', pid: child.pid });
    }
    return;
  }
  if (mode === 'malformed') { process.stdout.write('diagnostic on stdout\n'); return; }
  if (mode === 'oversized') { process.stdout.write('x'.repeat(4 * 1024 * 1024 + 1)); return; }
  if (mode === 'stderr-flood') { process.stderr.write('x'.repeat(1024 * 1024 + 1)); return; }
  if (mode === 'partial-exit') { process.stdout.write('{"protocolVersion":1'); process.exit(0); }
  if (mode === 'error') { send({ type: 'error', id, code: 'request-failed' }); return; }
  if (mode === 'resources-changed') { send({ type: 'error', id, code: mode }); return; }
  const result = { schemaVersion: 1, alignerVersion: request.alignerVersion, normalizeVersion: request.normalizeVersion,
    offsetUnit: 'utf16', normalizedText: request.normalizedText, durationSeconds: 1,
    segments: [{ start: 0, end: request.normalizedText.length, startSeconds: 0, endSeconds: 1, confidence: .9, status: 'aligned' }] };
  if (mode === 'invalid-result') result.segments[0].endSeconds = 2;
  const frame = { protocolVersion: 1, type: 'result', id: mode === 'wrong-id' ? 'other' : id, result, ...semantics };
  if (mode === 'wrong-method') frame.method = 'asr';
  if (mode === 'duplicate') { process.stdout.write(JSON.stringify(frame) + '\n' + JSON.stringify(frame) + '\n'); return; }
  if (mode === 'split') {
    const bytes = Buffer.from(JSON.stringify(frame) + '\n');
    const offset = bytes.indexOf(Buffer.from('窓')) + 1;
    process.stdout.write(bytes.subarray(0, offset));
    setTimeout(() => process.stdout.write(bytes.subarray(offset)), 10);
  } else {
    setTimeout(() => send(frame), mode === 'slow' ? 100 : 0);
  }
});
