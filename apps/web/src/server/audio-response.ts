export function audioResponse(bytes: Uint8Array, request: Request, mimeType: 'audio/wav' | 'audio/mpeg' = 'audio/wav'): Response {
  const headers = new Headers({ 'Content-Type': mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  const range = request.headers.get('range');
  let start = 0, end = bytes.byteLength - 1, status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return unsatisfiable();
    if (!match[1]) { const suffix = Number(match[2]); if (suffix <= 0) return unsatisfiable(); start = Math.max(0, bytes.byteLength - suffix); }
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.byteLength) return unsatisfiable();
    status = 206;
    headers.set('Content-Range', `bytes ${start}-${end}/${bytes.byteLength}`);
  }
  headers.set('Content-Length', String(end - start + 1));
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes.subarray(start, end + 1)).buffer, { status, headers });
  function unsatisfiable() {
    headers.set('Content-Range', `bytes */${bytes.byteLength}`);
    return new Response(null, { status: 416, headers });
  }
}
