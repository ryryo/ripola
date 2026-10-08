import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { ShareLink } from '../src/sharing/ShareLink.tsx';
import { createShareQr, getShareTarget } from '../src/sharing/qr.ts';

test('sharing preserves the ordinary HTTPS book URL and its identifier order', () => {
  const url = 'https://reader.example.com/books/book-123?revision=r1&id=book-123';
  assert.deepEqual(getShareTarget(url), { url, qrAllowed: true, reason: null, stripped: false });
});

test('sharing excludes manuscript, API credentials, unknown queries and fragments', () => {
  const input = 'https://reader.example.com/books/book-123?token=secret&book=book-123&text=private&api_key=secret&revision=r1&id=book-123#private-text';
  const target = getShareTarget(input);
  assert.equal(target.url, 'https://reader.example.com/books/book-123?book=book-123&revision=r1&id=book-123');
  assert.equal(target.qrAllowed, true);
  assert.equal(target.stripped, true);
  assert.doesNotMatch(target.url, /secret|private|token|api_key/);
  assert.deepEqual(createShareQr(input), createShareQr(target.url));
});

test('ambiguous or non-identifier query values are excluded from the share link', () => {
  const target = getShareTarget('https://reader.example.com/books/example?id=a&id=b&book=Hello%20world&revision=rev_1.2-3');
  assert.equal(target.url, 'https://reader.example.com/books/example?revision=rev_1.2-3');
});

test('local and private-network addresses never create a phone QR', () => {
  for (const host of ['localhost', 'localhost.', 'app.localhost', 'app.local', 'app.internal', 'app.test', 'devserver', '127.0.0.1', '127.100.0.1', '0x7f000001', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '169.254.1.1', '[::1]', '[::]', '[fc00::1]', '[fe80::1]', '[::ffff:127.0.0.1]']) {
    const target = getShareTarget(`https://${host}:4173/demo`);
    assert.equal(target.qrAllowed, false, host);
    assert.equal(target.reason, 'local', host);
    assert.equal(createShareQr(target.url), null, host);
  }
  const local = getShareTarget('http://127.0.0.1:4173/demo');
  assert.equal(local.url, 'http://127.0.0.1:4173/demo');
  assert.equal(local.reason, 'local');
});

test('HTTP can be copied but does not create a QR; non-page or credential URLs cannot be copied', () => {
  const http = getShareTarget('http://reader.example.com/demo');
  assert.equal(http.url, 'http://reader.example.com/demo');
  assert.equal(http.reason, 'https');
  assert.equal(createShareQr(http.url), null);
  for (const input of ['', '/demo', 'data:text/plain,private', 'javascript:alert(1)', 'file:///private/book.txt', 'https://person:secret@example.com/demo']) {
    assert.equal(getShareTarget(input).url, '', input);
    assert.equal(createShareQr(input), null, input);
  }
});

test('overlong page URLs are rejected instead of rendering unreadably dense QRs', () => {
  const target = getShareTarget(`https://reader.example.com/books/${'x'.repeat(600)}`);
  assert.equal(target.reason, 'too-long');
  assert.equal(target.url, '');
  assert.equal(createShareQr(`https://reader.example.com/books/${'x'.repeat(600)}`), null);
});

test('the SSR shell resolves neither a QR nor credential-bearing URL before browser hydration', () => {
  const markup = renderToStaticMarkup(createElement(MantineProvider, null,
    createElement(ShareLink, { url: 'https://example.com/demo?key=private', title: '音声デモ' })));
  assert.match(markup, /共有用URL/);
  assert.doesNotMatch(markup, /data-testid="share-qr"|https:\/\/example\.com|private/);
});

// Reference matrices were checked against the unmodified Nayuki encoder at
// 3c6d0b3cefb4e049dc337e82237c9644399716a8. Each rendered SVG was independently
// rasterized and decoded to the exact URL using jsQR (temporary verification,
// commit 8e6a036beafa7053dd44b1b76ac578d22b1b3311; no decoder dependency).
const references = [
  { url: 'https://example.com/demo', size: 33, sha256: 'f2330708b229181ea17874bfcec3cbfe2fbf8a2b5f14128ed02201325a860853' },
  { url: 'https://reader.example.com/books/book-123?revision=r1&id=book-123', size: 45, sha256: '7c6e2de761bfbec088d81848c25a03f5a6a6f31e309b844747e78b35bce89c78' },
  { url: 'https://reader.example.com/books/朝の図書館?id=book-123&revision=deadbeef', size: 53, sha256: '8ff64f65564b929d84dadfeec0c0d9996b7383d89aaaddbe592aecdc1a291889' },
  { url: `https://reader.example.com/books/${'x'.repeat(460)}`, size: 93, sha256: '7fc4d1ad55c2b20434f21f023a74d663bdc8a262adc7364c5e50632fad2a7954' },
];

test('QR matrices match independently decoded reference symbols, including UTF-8 and larger versions', () => {
  for (const reference of references) {
    const qr = createShareQr(reference.url);
    assert.ok(qr);
    assert.equal(qr.size, reference.size);
    const matrix = qr.modules.map(row => row.map(Number).join('')).join('\n');
    assert.equal(createHash('sha256').update(matrix).digest('hex'), reference.sha256);
  }
});

test('SVG paths retain all modules and the required four-module white quiet zone', () => {
  const qr = createShareQr(references[1].url);
  assert.ok(qr);
  const canvas = Array.from({ length: qr.size }, () => new Array<boolean>(qr.size).fill(false));
  for (const match of qr.path.matchAll(/M(\d+),(\d+)h(\d+)v1h-(\d+)z/g)) {
    const [, x, y, width, negativeWidth] = match.map(Number);
    assert.equal(width, negativeWidth);
    for (let px = x; px < x + width; px++) canvas[y][px] = true;
  }
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (x < 4 || y < 4 || x >= qr.size - 4 || y >= qr.size - 4) assert.equal(canvas[y][x], false);
      else assert.equal(canvas[y][x], qr.modules[y - 4][x - 4]);
    }
  }
});
