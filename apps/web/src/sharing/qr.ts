import { qrcodegen } from './vendor/qrcodegen';

const MAX_SHARE_URL_LENGTH = 512;
const SHARE_QUERY_KEYS = new Set(['book', 'id', 'revision', 'sample']);
const SHARE_SAMPLES = new Set(['voicevox', 'gemini-male', 'gemini-female']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ShareTarget {
  url: string;
  qrAllowed: boolean;
  reason: 'https' | 'local' | 'invalid' | 'too-long' | null;
  stripped: boolean;
}

/** Share the normal document URL, never URL-embedded credentials, text or tokens. */
export function getShareTarget(input: string): ShareTarget {
  const invalid: ShareTarget = { url: '', qrAllowed: false, reason: 'invalid', stripped: false };
  let url: URL;
  try { url = new URL(input); } catch { return invalid; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return invalid;

  const search = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (SHARE_QUERY_KEYS.has(key) && url.searchParams.getAll(key).length === 1 && IDENTIFIER.test(value)
      && (key !== 'sample' || SHARE_SAMPLES.has(value))) search.append(key, value);
  }
  url.search = search.toString();
  url.hash = '';
  const safeUrl = url.href;
  const stripped = safeUrl !== input;
  if (safeUrl.length > MAX_SHARE_URL_LENGTH) return { ...invalid, reason: 'too-long', stripped };
  if (isLocalHost(url.hostname)) return { url: safeUrl, qrAllowed: false, reason: 'local', stripped };
  if (url.protocol !== 'https:') return { url: safeUrl, qrAllowed: false, reason: 'https', stripped };
  return { url: safeUrl, qrAllowed: true, reason: null, stripped };
}

function isLocalHost(host: string): boolean {
  const hostname = host.toLowerCase().replace(/\.$/, '');
  if (!hostname.includes('.') && !hostname.includes(':')) return true;
  if (/\.(?:localhost|local|internal|test)$/.test(hostname)) return true;
  const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(hostname);
  if (ipv4) {
    const [, first, second] = ipv4.map(Number);
    return first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127);
  }
  if (hostname.startsWith('[')) {
    const address = hostname.slice(1, -1);
    if (address === '::' || address === '::1' || /^(?:f[cd]|fe[89ab])/.test(address)) return true;
    // IPv4-mapped IPv6 literals are unnecessary for deployed share links.
    if (address.startsWith('::ffff:')) return true;
  }
  return false;
}

export interface ShareQr {
  /** Includes the mandatory four-module white quiet zone on each edge. */
  size: number;
  path: string;
  modules: ReadonlyArray<ReadonlyArray<boolean>>;
}

/** The encoder and renderer are entirely local; their payload is the validated URL. */
export function createShareQr(input: string): ShareQr | null {
  const target = getShareTarget(input);
  if (!target.qrAllowed) return null;
  const qr = qrcodegen.QrCode.encodeText(target.url, qrcodegen.QrCode.Ecc.MEDIUM);
  const border = 4;
  const modules = Array.from({ length: qr.size }, (_, y) => Array.from({ length: qr.size }, (_, x) => qr.getModule(x, y)));
  const paths: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!modules[y][x]) continue;
      const start = x;
      while (x + 1 < qr.size && modules[y][x + 1]) x++;
      const width = x - start + 1;
      paths.push(`M${start + border},${y + border}h${width}v1h-${width}z`);
    }
  }
  return { size: qr.size + border * 2, path: paths.join(''), modules };
}
