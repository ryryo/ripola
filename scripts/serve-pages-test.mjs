// Test-only HTTP server for the audited Pages artifact. Never proxies to the local generation API.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/distribution/pages/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm', '.pdf': 'application/pdf' };
await stat(resolve(root, 'distribution.json')); // A missing build must fail before the readiness probe.
const port = Number(process.env.RSVP_PAGES_TEST_PORT ?? 4175);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid Pages test port');
createServer((request, response) => {
  void (async () => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!['GET', 'HEAD'].includes(request.method) || !pathname.startsWith('/ripola/')) { response.writeHead(404).end(); return; }
    let path = resolve(root, pathname.slice('/ripola/'.length));
    if (path !== resolve(root) && !path.startsWith(resolve(root) + sep)) { response.writeHead(404).end(); return; }
    if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
    const bytes = await readFile(path);
    const headers = { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    if (range) {
      const start = Number(range[1]); const end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1);
      if (start > end || start >= bytes.length) { response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }).end(); return; }
      response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 });
      response.end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
    } else {
      response.writeHead(200, { ...headers, 'Content-Length': bytes.length }); response.end(request.method === 'HEAD' ? undefined : bytes);
    }
  })().catch(() => { response.writeHead(404).end(); });
}).listen(port, '127.0.0.1', () => console.log(`Audited Pages test server: http://127.0.0.1:${port}/ripola/`));
