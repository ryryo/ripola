import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalRequest } from '../src/server/local-request';

const local = (headers: Record<string, string>, url = 'http://127.0.0.1:4173/_serverFn/test') => new Request(url, { headers });
test('local API requires a trusted Host and same-origin browser evidence', () => {
  assert.doesNotThrow(() => assertLocalRequest(local({ host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' })));
  assert.doesNotThrow(() => assertLocalRequest(local({ 'sec-fetch-site': 'same-origin' })));
  assert.throws(() => assertLocalRequest(local({ origin: 'https://attacker.example' })));
  assert.throws(() => assertLocalRequest(local({ host: 'attacker.example', 'sec-fetch-site': 'same-origin' })));
  assert.throws(() => assertLocalRequest(local({ 'sec-fetch-site': 'cross-site' })));
  assert.throws(() => assertLocalRequest(local({})));
  assert.throws(() => assertLocalRequest(local({ 'sec-fetch-site': 'same-origin' }, 'http://192.168.1.20:4173/_serverFn/test')));
  assert.throws(() => assertLocalRequest(local({ origin: 'http://127.0.0.1:4173' }), 'https://attacker.example'));
});
