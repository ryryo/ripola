/** Local network boundary; never accepts a browser-supplied path or upstream URL. */
export function assertLocalRequest(request: Request, configuredOrigin?: string): void {
  const allowed = configuredOrigin ? [configuredOrigin] : ['http://127.0.0.1:4173', 'http://127.0.0.1:4174'];
  for (const value of allowed) {
    const origin = new URL(value);
    if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.origin !== value) throw new Error('Local origin configuration must be a loopback HTTP origin');
  }
  const url = new URL(request.url);
  const host = request.headers.get('host');
  if (!allowed.includes(url.origin) || (host !== null && host !== url.host)) throw new Error('Forbidden local Host');
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (origin !== null && origin !== url.origin) throw new Error('Forbidden local Origin');
  if (fetchSite !== null && fetchSite !== 'same-origin') throw new Error('Forbidden cross-site request');
  if (origin === null && fetchSite !== 'same-origin') {
    const referer = request.headers.get('referer');
    if (!referer || new URL(referer).origin !== url.origin) throw new Error('Origin verification required');
  }
}
