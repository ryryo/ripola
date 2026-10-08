/* global Headers, Request, Response, caches */
/** Static, content-addressed sample or personal audio only. No TTS or generation handler. This cache is not library storage. */
export default {
  /** @param {Request} request @param {Env} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (/^\/(?:api\/local-|_serverFn(?:\/|$)|generate(?:\/|$))/.test(url.pathname)) return new Response('Not found', { status: 404 });
    if (!/^\/(?:samples\/audio\/)?library\/books\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/media\/[a-f0-9]{64}\.(?:m4a|mp3)$/.test(url.pathname)
      || !['GET', 'HEAD'].includes(request.method)) return env.ASSETS.fetch(request);
    const range = request.headers.get('Range');
    if (!range || request.method === 'HEAD') {
      const response = await env.ASSETS.fetch(request);
      if (response.status !== 200) return response;
      const headers = new Headers(response.headers); headers.set('Accept-Ranges', 'bytes');
      if (request.method === 'HEAD') {
        const metadata = await env.ASSETS.fetch(new Request(new URL('/library/audio-sizes.json', url)));
        const sizes = metadata.ok ? await metadata.json() : {};
        const length = Number(sizes[url.pathname.slice(1)]);
        if (Number.isSafeInteger(length) && length > 0 && length <= 25 * 1024 * 1024) headers.set('Content-Length', String(length));
      }
      return new Response(response.body, { status: response.status, headers });
    }
    // Cache API implements byte ranges for cached 200 responses with Content-Length.
    // Consume the asset stream into cache without cloning or buffering it in JS.
    url.search = '';
    const key = new Request(url, { method: 'GET' });
    const lookup = new Request(key, { headers: { Range: range } });
    const cache = caches.default;
    let response = await cache.match(lookup);
    if (!response) {
      const asset = await env.ASSETS.fetch(key);
      if (asset.status !== 200) return asset;
      const metadata = await env.ASSETS.fetch(new Request(new URL('/library/audio-sizes.json', url)));
      const sizes = metadata.ok ? await metadata.json() : {};
      const length = Number(sizes[url.pathname.slice(1)]);
      if (!Number.isSafeInteger(length) || length < 1 || length > 25 * 1024 * 1024) {
        await asset.body?.cancel();
        return env.ASSETS.fetch(request);
      }
      const headers = new Headers(asset.headers);
      headers.set('Content-Length', String(length));
      headers.set('Cache-Control', 'public, max-age=86400, immutable');
      headers.set('Accept-Ranges', 'bytes');
      await cache.put(key, new Response(asset.body, { status: 200, headers }));
      response = await cache.match(lookup);
    }
    if (!response) return env.ASSETS.fetch(request);
    const ifRange = request.headers.get('If-Range');
    if (ifRange && ifRange !== response.headers.get('ETag')) {
      await response.body?.cancel();
      return env.ASSETS.fetch(key);
    }
    return response;
  },
};
