import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GEMINI_ENDPOINT, geminiAdapter, gatewayEndpoint, SpeechRequestError, VOICEVOX_ENDPOINT, voicevoxAdapter } from '../src/generation/core/providers.ts';

function testWav(): Uint8Array {
  const bytes = Buffer.alloc(44 + 32000);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(32000, 40); return bytes;
}

test('VOICEVOX uses only fixed loopback endpoints and records sending before synthesis', async (t) => {
  const events: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(init.redirect, 'error'); assert.ok(url.startsWith(VOICEVOX_ENDPOINT));
    if (url.endsWith('/version')) return new Response(JSON.stringify('0.25.2'));
    if (url.endsWith('/speakers')) return new Response(JSON.stringify([{ name: '検証声', styles: [{ id: 3, name: '普通' }] }]));
    if (url.includes('/audio_query?')) {
      events.push('query'); assert.equal(new URL(url).searchParams.get('text'), 'これは自作文です。'); assert.equal(init.method, 'POST');
      return new Response(JSON.stringify({ accent_phrases: [] }));
    }
    events.push('synthesis'); assert.equal(new URL(url).searchParams.get('speaker'), '3'); assert.equal(init.method, 'POST');
    return new Response(testWav() as BodyInit);
  });
  const adapter = voicevoxAdapter();
  assert.equal(await adapter.fingerprint!(), 'voicevox-engine:0.25.2');
  assert.deepEqual(await adapter.voices(), [{ id: '3', name: '検証声 / 普通', speakerName: '検証声', styleName: '普通' }]);
  const audio = await adapter.synthesize({ text: 'これは自作文です。', options: { provider: 'voicevox', voice: '3', transport: 'direct', readings: [] } }, async () => { events.push('sending'); });
  assert.deepEqual(events, ['query', 'sending', 'synthesis']); assert.deepEqual(Buffer.from(audio), Buffer.from(testWav()));
});

test('Gemini uses verified Interactions structure, two allowed models, metadata style and a server-only header', async (t) => {
  let sent = false;
  const credential = 'mock-private-header-only';
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(sent, true); assert.equal(url, GEMINI_ENDPOINT); assert.equal(init.redirect, 'error');
    const headers = new Headers(init.headers); assert.equal(headers.get('x-goog-api-key'), credential);
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, 'gemini-3.8-flash-lite-tts'); assert.ok(!JSON.stringify(body).includes(credential));
    assert.equal(body.input[0].content[0].text, '朝の光が差します。'); assert.equal(body.input[0].content[0].annotations[0].style, '落ち着いた語り');
    assert.deepEqual(body.response_format, { type: 'audio', mime_type: 'audio/wav' });
    assert.deepEqual(body.generation_config.speech_config, [{ voice: 'Kore' }]);
    return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: Buffer.from(testWav()).toString('base64') }] }] }));
  });
  const audio = await geminiAdapter(credential).synthesize({ text: '朝の光が差します。', options: { provider: 'gemini', voice: 'Kore', transport: 'direct', readings: [], style: '落ち着いた語り' } }, async () => { sent = true; });
  assert.deepEqual(Buffer.from(audio), Buffer.from(testWav()));
});

test('provider errors redact remote response content and distinguish uncertain transport outcomes', async (t) => {
  const adapter = geminiAdapter('mock-private-header-only');
  const request = { text: '自作文です。', options: { provider: 'gemini' as const, voice: 'Kore', transport: 'direct' as const, readings: [] } };
  const method = t.mock.method(globalThis, 'fetch', async () => new Response('remote-private-error-content', { status: 401 }));
  await assert.rejects(adapter.synthesize(request, async () => undefined), (error: unknown) => error instanceof Error && error.message.includes('401') && !error.message.includes('private'));
  method.mock.mockImplementation(async () => { throw new Error('secret in network exception'); });
  await assert.rejects(adapter.synthesize(request, async () => undefined), (error: unknown) => error instanceof Error && 'outcomeUnknown' in error && error.outcomeUnknown === true && !error.message.includes('secret'));
  method.mock.mockImplementation(async () => { throw new Error('should not execute'); });
  await assert.rejects(adapter.synthesize({ ...request, options: { ...request.options, transport: 'gateway' } }, async () => undefined), /Gateway/);
});

const gateway = { accountId: 'a'.repeat(32), gatewayId: 'reader', token: 'mock-gateway-secret' };
const gatewayRequest = { text: 'これは検証用の自作文です。', options: { provider: 'gemini' as const, voice: 'Kore', transport: 'gateway' as const, readings: [] } };
function unifiedAudio(audio: unknown = Buffer.from(testWav()).toString('base64'), keySource: string | undefined = 'Unified') {
  return {success: true, result: {audio, gatewayMetadata: {keySource}, usage: {input_tokens: 12, output_tokens: 25, unsafe_extra: 'private text'}}};
}

test('Cloudflare sends only inference without a Google key or management API reads', async t => {
  const events: string[] = []; let metadata: unknown;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    assert.equal(headers.get('x-goog-api-key'), null); assert.equal(headers.get('authorization'), `Bearer ${gateway.token}`);
    assert.equal(init.method, 'POST');
    events.push('cloudflare'); assert.equal(url, gatewayEndpoint(gateway));
    assert.equal(headers.get('cf-aig-authorization'), null); assert.equal(headers.get('cf-aig-no-wholesale'), null);
    for (const [key, value] of Object.entries({ 'cf-aig-gateway-id': 'reader', 'cf-aig-collect-log': 'false', 'cf-aig-skip-cache': 'true', 'cf-aig-max-attempts': '1', 'cf-aig-request-timeout': '120000' })) assert.equal(headers.get(key), value);
    assert.deepEqual(JSON.parse(String(init.body)), {model: 'google/gemini-3.8-flash-lite-tts', input: {text: gatewayRequest.text, voice: 'Kore'}});
    assert.ok(!String(init.body).includes('secret'));
    return new Response(JSON.stringify(unifiedAudio()));
  });
  // Even a separately configured Google key cannot escape through this route.
  const bytes = await geminiAdapter('mock-google-secret', gateway).synthesize({...gatewayRequest, captureReceipt: value => { metadata = value; }}, async () => {events.push('sending');});
  assert.deepEqual(events, ['sending', 'cloudflare']); assert.deepEqual(Buffer.from(bytes), Buffer.from(testWav()));
  assert.deepEqual(metadata, {schemaVersion: 1, transport: 'gateway', endpoint: gatewayEndpoint(gateway), model: 'gemini-3.8-flash-lite-tts', keySource: 'Unified', usage: {input_tokens: 12, output_tokens: 25}});
  await geminiAdapter(undefined, gateway).synthesize(gatewayRequest, async () => undefined);
});

test('Cloudflare validates local settings and unsupported style without network calls', async t => {
  let calls = 0; let sends = 0;
  t.mock.method(globalThis, 'fetch', async () => {calls++; throw new Error('unexpected network');});
  const send = async () => {sends++;};
  await assert.rejects(geminiAdapter(undefined).synthesize(gatewayRequest, send), /Gateway/);
  await assert.rejects(geminiAdapter(undefined, {...gateway, gatewayId: ''}).synthesize(gatewayRequest, send), /Gatewayの選択/);
  await assert.rejects(geminiAdapter(undefined, gateway).synthesize({...gatewayRequest, options: {...gatewayRequest.options, style: '静かに'}}, send), /未対応/);
  assert.equal(calls, 0); assert.equal(sends, 0);
});

test('Cloudflare accepts valid audio with BYOK or absent billing metadata', async t => {
  let source: string | undefined = 'BYOK'; let metadata: unknown; let posts = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, gatewayEndpoint(gateway)); assert.equal(init.method, 'POST'); posts++;
    const payload = unifiedAudio();
    payload.result.gatewayMetadata = source ? {keySource: source} : {} as never;
    return new Response(JSON.stringify(payload));
  });
  const adapter = geminiAdapter(undefined, gateway);
  for (const value of ['BYOK', undefined]) {
    source = value;
    assert.deepEqual(await adapter.synthesize({...gatewayRequest, captureReceipt: v => {metadata = v;}}, async () => undefined), testWav());
    assert.equal((metadata as {keySource?: string}).keySource, value);
  }
  assert.equal(posts, 2);
});

test('Cloudflare errors and unverifiable responses never invoke Direct or retry paid POST', async t => {
  let code = 504; let paidCalls = 0; let kind = 'http';
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(init.method, 'POST');
    assert.equal(url, gatewayEndpoint(gateway)); paidCalls++;
    if (kind === 'http') return new Response('private upstream details', {status: code});
    if (kind === 'body') return new Response(new ReadableStream({start(controller) {controller.error(new Error('private abort body'));}}));
    return new Response(JSON.stringify(unifiedAudio('not valid base64')));
  });
  const adapter = geminiAdapter('mock-google-secret', gateway);
  for (const [status, uncertain, message] of [[401, false, /Workers AI Read/], [402, false, /残高/], [429, false, /429/], [504, true, /504/]] as const) {
    code = status; await assert.rejects(adapter.synthesize(gatewayRequest, async () => undefined), error => error instanceof SpeechRequestError && error.outcomeUnknown === uncertain && message.test(error.message) && !error.message.includes('private'));
  }
  for (const failure of ['body', 'json']) {
    kind = failure; await assert.rejects(adapter.synthesize(gatewayRequest, async () => undefined), error => error instanceof SpeechRequestError && error.outcomeUnknown && !error.message.includes('private'));
  }
  assert.equal(paidCalls, 6);
});

test('Cloudflare hosted WAV is downloaded once without credentials; unsafe URLs fail closed', async t => {
  let posts = 0; let downloads = 0; let audio = 'https://examples.aig.cloudflare.com/google/test.wav'; let oversized = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.startsWith('https://api.cloudflare.com/')) {
      assert.equal(init.method, 'POST');
      posts++; return new Response(JSON.stringify(unifiedAudio(audio)));
    }
    downloads++; assert.equal(url, audio); assert.equal(init.redirect, 'error'); assert.equal(new Headers(init.headers).get('authorization'), null); assert.equal(new Headers(init.headers).get('x-goog-api-key'), null);
    return new Response(testWav() as BodyInit, {headers: {'content-length': oversized ? String(65 * 1024 * 1024) : String(testWav().length)}});
  });
  const adapter = geminiAdapter(undefined, gateway);
  assert.deepEqual(Buffer.from(await adapter.synthesize(gatewayRequest, async () => undefined)), Buffer.from(testWav()));
  for (const url of ['https://127.0.0.1/private.wav', 'https://unexpected.example/a.wav', 'https://examples.aig.cloudflare.com.evil.example/a.wav', 'https://user:secret@examples.aig.cloudflare.com/a.wav']) {
    audio = url; await assert.rejects(adapter.synthesize(gatewayRequest, async () => undefined), error => error instanceof SpeechRequestError && error.outcomeUnknown);
  }
  assert.equal(downloads, 1); assert.equal(posts, 5);
  audio = 'https://examples.aig.cloudflare.com/google/test.wav'; oversized = true;
  await assert.rejects(adapter.synthesize(gatewayRequest, async () => undefined), error => error instanceof SpeechRequestError && error.outcomeUnknown);
  assert.equal(posts, 6); assert.equal(downloads, 2);
});


test('Cloudflare accepts documented bare WAV output for Flash and rejects an unapproved model before any request', async t => {
  let posts = 0; let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, gatewayEndpoint(gateway));
    assert.equal(init.method, 'POST');
    posts++;
    assert.deepEqual(JSON.parse(String(init.body)), {model: 'google/gemini-3.8-flash-tts', input: {text: gatewayRequest.text, voice: 'Puck'}});
    return new Response(JSON.stringify({audio: 'data:audio/wav;base64,' + Buffer.from(testWav()).toString('base64'), gatewayMetadata: {keySource: 'Unified'}}));
  });
  const adapter = geminiAdapter(undefined, gateway);
  const request = {...gatewayRequest, options: {...gatewayRequest.options, model: 'gemini-3.8-flash-tts' as const, voice: 'Puck'}};
  assert.deepEqual(Buffer.from(await adapter.synthesize(request, async () => undefined)), Buffer.from(testWav()));
  const before = calls;
  await assert.rejects(adapter.synthesize({...request, options: {...request.options, model: 'unapproved-model' as never}}, async () => undefined), /model/);
  assert.equal(calls, before); assert.equal(posts, 1);
});


const bindingGateway = { mode: 'wrangler' as const, configPath: '/mock/local-ai.wrangler.jsonc', gatewayId: 'reader' };
test('Wrangler availability needs a Gateway ID and preflight performs no remote operation', async t => {
  t.mock.method(globalThis, 'fetch', async () => {throw new Error('management read forbidden');});
  const configured = geminiAdapter(undefined, bindingGateway);
  assert.equal(configured.availability?.().available, true);
  await configured.preflight?.(gatewayRequest.options);
  const missing = geminiAdapter(undefined, {...bindingGateway, gatewayId: ''});
  assert.equal(missing.availability?.().available, false);
  await assert.rejects(missing.preflight!(gatewayRequest.options), /Gatewayの選択/);
});
test('Wrangler binding calls AI.run once without credential-based fetch and disposes', async t => {
  const events: string[] = []; let metadata: unknown;
  t.mock.method(globalThis, 'fetch', async () => {throw new Error('Token fetch forbidden');});
  const adapter = geminiAdapter('unused-google-secret', bindingGateway, {
    async connect(config) {assert.equal('token' in config, false); events.push('connect'); return {
      ai: {async run(model, input, opts) {
        events.push('run'); assert.equal(model, 'google/gemini-3.8-flash-lite-tts');
        assert.deepEqual(input, {text: gatewayRequest.text, voice: 'Kore'});
        assert.deepEqual(opts, {gateway: {id: 'reader', collectLog: false, skipCache: true}});
        return {audio: Buffer.from(testWav()).toString('base64'), gatewayMetadata: {keySource: 'Unified'}};
      }}, async dispose() {events.push('dispose');}};},
  });
  const bytes = await adapter.synthesize({...gatewayRequest, captureReceipt: v => {metadata = v;}}, async () => {events.push('sending');});
  assert.deepEqual(bytes, testWav()); assert.deepEqual(events, ['connect','sending','run','dispose']);
  assert.deepEqual(metadata, {schemaVersion: 1, transport: 'gateway', endpoint: gatewayEndpoint(bindingGateway), model: 'gemini-3.8-flash-lite-tts', keySource: 'Unified'});
  assert.equal(JSON.stringify(metadata).includes('secret'), false);
});
test('Wrangler connection failures never send; remote errors never retry or fall back', async () => {
  let connects = 0; let sends = 0; let runs = 0; let disposed = 0;
  const runtime = {async connect() {connects++; throw new Error('secret');}};
  await assert.rejects(geminiAdapter(undefined, bindingGateway, runtime).synthesize(gatewayRequest, async () => {sends++;}), e => e instanceof SpeechRequestError && !e.outcomeUnknown && !e.message.includes('secret'));
  assert.equal(connects, 1); assert.equal(sends, 0);
  const failing = {async connect() {return {ai: {async run() {runs++; throw new Error('secret');}}, async dispose() {disposed++;}};}};
  await assert.rejects(geminiAdapter('unused', bindingGateway, failing).synthesize(gatewayRequest, async () => {sends++;}), e => e instanceof SpeechRequestError && e.outcomeUnknown && !e.message.includes('secret'));
  assert.equal(runs, 1); assert.equal(sends, 1); assert.equal(disposed, 1);
});
test('Wrangler accepts BYOK audio and cancellation before sending disposes without inference', async () => {
  let runs = 0; let disposed = 0;
  const runtime = {async connect() {return {ai: {async run() {runs++; return {audio: Buffer.from(testWav()).toString('base64'), gatewayMetadata: {keySource: 'BYOK'}};}}, async dispose() {disposed++;}};}};
  const adapter = geminiAdapter(undefined, bindingGateway, runtime);
  await assert.rejects(adapter.synthesize(gatewayRequest, async () => {throw new Error('cancelled');}), /cancelled/);
  assert.equal(runs, 0); assert.equal(disposed, 1);
  assert.deepEqual(await adapter.synthesize(gatewayRequest, async () => undefined), testWav());
  assert.equal(runs, 1); assert.equal(disposed, 2);
});
