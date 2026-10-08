import { GEMINI_MODELS, type GenerationOptions, type VoiceOption, type SpeechReceipt } from '../contracts';
import type { GeminiGatewayConfig } from './config';
import { wranglerAiRuntime, WRANGLER_GATEWAY_MISSING, type WranglerAiRuntime } from './wrangler-ai';

export const VOICEVOX_ENDPOINT = 'http://127.0.0.1:50021';
export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export const GEMINI_VOICES: VoiceOption[] = ['Kore', 'Puck', 'Aoede', 'Charon', 'Fenrir', 'Leda', 'Orus', 'Zephyr'].map((id) => ({ id, name: id }));
export class SpeechRequestError extends Error {
  constructor(message: string, readonly outcomeUnknown = false) { super(message); }
}
export interface SpeechRequest { text: string; options: GenerationOptions; captureVoicevoxQuery?: (query: unknown) => void; captureReceipt?: (receipt: SpeechReceipt) => void }
export interface SpeechAdapter {
  synthesize(request: SpeechRequest, beforeSend: () => Promise<void>): Promise<Uint8Array>;
  voices(): Promise<VoiceOption[]>;
  fingerprint?(): Promise<string>;
  preflight?(options: GenerationOptions): Promise<void>;
  availability?(): { available: boolean; message?: string };
}

async function boundedBytes(response: Response, maximum = 64 * 1024 * 1024): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > maximum) throw new SpeechRequestError('音声応答が大きすぎます。', true);
  if (!response.body) throw new SpeechRequestError('音声応答がありません。', true);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      if (total > maximum) { await reader.cancel(); throw new SpeechRequestError('音声応答が大きすぎます。', true); }
      parts.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
async function checkedFetch(url: string, init: RequestInit, paid = false): Promise<Response> {
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(120_000) }); }
  catch { throw new SpeechRequestError('生成先からの応答を確認できませんでした。', true); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new SpeechRequestError(`生成先がエラーを返しました（HTTP ${response.status}）。`, paid && (response.status >= 500 || response.status === 408));
  }
  return response;
}

export function voicevoxAdapter(): SpeechAdapter {
  return {
    async fingerprint() {
      const response = await fetch(`${VOICEVOX_ENDPOINT}/version`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error('Engineのversionが取得できません。');
      const version: unknown = JSON.parse(Buffer.from(await boundedBytes(response, 1024)).toString('utf8'));
      if (typeof version !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(version)) throw new Error('Engineのversionが正しくありません。');
      return `voicevox-engine:${version}`;
    },
    async voices() {
      const response = await fetch(`${VOICEVOX_ENDPOINT}/speakers`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error('VOICEVOXへ接続できません。');
      const json: unknown = JSON.parse(Buffer.from(await boundedBytes(response, 2 * 1024 * 1024)).toString('utf8'));
      if (!Array.isArray(json)) throw new Error('VOICEVOXの声一覧が正しくありません。');
      return json.flatMap((speaker: { name?: unknown; styles?: unknown }) => {
        if (typeof speaker.name !== 'string' || !Array.isArray(speaker.styles)) return [];
        return speaker.styles.filter((style: { id?: unknown; name?: unknown }) => Number.isInteger(style.id) && typeof style.name === 'string')
          .map((style: { id: number; name: string }) => ({ id: String(style.id), name: `${speaker.name} / ${style.name}`, speakerName: speaker.name as string, styleName: style.name }));
      });
    },
    async synthesize({ text, options, captureVoicevoxQuery }, beforeSend) {
      if (!/^\d{1,8}$/.test(options.voice)) throw new SpeechRequestError('VOICEVOXのstyle IDが正しくありません。');
      const query = await checkedFetch(`${VOICEVOX_ENDPOINT}/audio_query?${new URLSearchParams({ speaker: options.voice, text })}`, { method: 'POST' });
      const queryBytes = await boundedBytes(query, 4 * 1024 * 1024);
      captureVoicevoxQuery?.(JSON.parse(Buffer.from(queryBytes).toString('utf8')));
      await beforeSend();
      const audio = await checkedFetch(`${VOICEVOX_ENDPOINT}/synthesis?${new URLSearchParams({ speaker: options.voice })}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: queryBytes as BodyInit,
      });
      return boundedBytes(audio);
    },
  };
}

export function gatewayEndpoint(gateway: GeminiGatewayConfig): string {
  return gateway.mode === 'wrangler' ? 'Cloudflare Workers AI binding · Wrangler' : `https://api.cloudflare.com/client/v4/accounts/${gateway.accountId}/ai/run`;
}
export function gatewayRouteIdentity(gateway: GeminiGatewayConfig): string {
  return gateway.mode === 'wrangler' ? `cloudflare-wrangler-gateway-v2:${gateway.accountId ?? 'wrangler-account'}:${gateway.gatewayId}` : `cloudflare-gateway-v2:${gateway.accountId}:${gateway.gatewayId}`;
}

function base64Wav(data: string): Uint8Array {
  if (!data || data.length > 90 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('invalid audio');
  const bytes = Buffer.from(data, 'base64');
  wavDuration(bytes);
  return bytes;
}

/** Model docs show both base64 WAV and hosted WAV. Never forward credentials to an audio URL. */
async function cloudflareAudio(audio: unknown): Promise<Uint8Array> {
  if (typeof audio !== 'string') throw new Error('missing audio');
  if (!audio.startsWith('https:')) return base64Wav(audio.startsWith('data:audio/wav;base64,') ? audio.slice('data:audio/wav;base64,'.length) : audio);
  const url = new URL(audio);
  // Cloudflare documents examples.aig.cloudflare.com; unknown storage hosts fail closed.
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash
    || !url.hostname.endsWith('.aig.cloudflare.com') || !url.pathname.toLowerCase().endsWith('.wav')) throw new Error('untrusted audio URL');
  const response = await checkedFetch(url.href, { method: 'GET' });
  const bytes = await boundedBytes(response);
  wavDuration(bytes);
  return bytes;
}

function receipt(payload: Record<string, unknown>, options: GenerationOptions, endpoint: string): SpeechReceipt {
  const usage: Record<string, number> = {};
  const raw = payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : {};
  for (const key of ['total_input_tokens', 'total_output_tokens', 'total_cached_tokens', 'total_tokens', 'input_tokens', 'output_tokens']) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) usage[key] = value;
  }
  const id = typeof payload.id === 'string' && /^[a-zA-Z0-9_.-]{1,512}$/.test(payload.id) ? payload.id : undefined;
  return { schemaVersion: 1, transport: options.transport, endpoint, model: options.model ?? GEMINI_MODELS[0],
    ...(id ? { interactionId: id } : {}), ...(Object.keys(usage).length ? { usage } : {}) };
}

/** Optional provider metadata is recorded, never used as an inference prerequisite. */
function cloudflareReceipt(payload: Record<string, unknown>, options: GenerationOptions, endpoint: string): SpeechReceipt {
  const metadata = payload.gatewayMetadata;
  const source = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).keySource : undefined;
  return { ...receipt(payload, options, endpoint), ...(source === 'Unified' || source === 'BYOK' ? { keySource: source } : {}) };
}

/** Direct Google Interactions or Cloudflare AI Gateway, selected explicitly. */
export function geminiAdapter(apiKey: string | undefined, gateway?: GeminiGatewayConfig, runtime: WranglerAiRuntime = wranglerAiRuntime): SpeechAdapter {
  async function preflight(options: GenerationOptions) {
    if (options.transport === 'gateway') {
      if (options.style) throw new SpeechRequestError('Cloudflare経路は読み上げ方の指示に未対応です。指示を空にするかGemini直結を選んでください。');
      if (!gateway) throw new SpeechRequestError('Gatewayのサーバー設定が未完了です。');
      if (!gateway.gatewayId) throw new SpeechRequestError(WRANGLER_GATEWAY_MISSING);
    }
  }
  return {
    async voices() { return GEMINI_VOICES; },
    availability() {
      return { available: Boolean(gateway?.gatewayId), ...(gateway?.mode === 'wrangler' ? { message: gateway.gatewayId
        ? '既存Wranglerログインを利用するGateway設定があります。実接続・残高は未確認です。'
        : WRANGLER_GATEWAY_MISSING } : {}) };
    },
    preflight,
    async synthesize({ text, options, captureReceipt }, beforeSend) {
      if (!GEMINI_MODELS.includes(options.model ?? GEMINI_MODELS[0]) || !GEMINI_VOICES.some((voice) => voice.id === options.voice)) throw new SpeechRequestError('Geminiのmodelまたはvoiceが正しくありません。');
      if (options.transport === 'direct' && !apiKey) throw new SpeechRequestError('Google API keyが未設定です。');
      if (options.transport === 'gateway' && (!text || [...text].length > 10_000)) throw new SpeechRequestError('Cloudflareへ送る本文は1〜10000文字にしてください。');
      await preflight(options);
      const endpoint = options.transport === 'gateway' ? gatewayEndpoint(gateway!) : GEMINI_ENDPOINT;
      if (options.transport === 'gateway' && gateway?.mode === 'wrangler') {
        let connection: Awaited<ReturnType<WranglerAiRuntime['connect']>>;
        try { connection = await runtime.connect(gateway); }
        catch { throw new SpeechRequestError('既存Wrangler認証でremote AI bindingへ接続できません。既存ログインの状態と対象アカウントを確認してください。'); }
        try {
          await beforeSend();
          let decoded: unknown;
          try {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              decoded = await Promise.race([
                connection.ai.run(`google/${options.model ?? GEMINI_MODELS[0]}`, { text, voice: options.voice }, { gateway: { id: gateway.gatewayId, collectLog: false, skipCache: true } }),
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('binding timeout')), 120_000); timer.unref(); }),
              ]);
            } finally { if (timer) clearTimeout(timer); }
          } catch { throw new SpeechRequestError('Cloudflare bindingの生成結果を確認できません。再送せず結果不明として保存します。', true); }
          try {
            const data = decoded as Record<string, unknown> | undefined;
            if (!data || typeof data !== 'object') throw new Error('invalid response');
            const bytes = await cloudflareAudio(data.audio);
            captureReceipt?.(cloudflareReceipt(data, options, endpoint));
            return bytes;
          } catch { throw new SpeechRequestError('Cloudflare bindingの音声を検証できません。再送せず結果不明として保存します。', true); }
        } finally { await connection.dispose().catch(() => undefined); }
      }
      const rest = gateway?.mode === 'wrangler' ? undefined : gateway;
      const headers: Record<string, string> = options.transport === 'gateway' ? {
        'Content-Type': 'application/json', Authorization: `Bearer ${rest!.token}`,
        'cf-aig-gateway-id': gateway!.gatewayId,
        'cf-aig-collect-log': 'false', 'cf-aig-skip-cache': 'true', 'cf-aig-max-attempts': '1', 'cf-aig-request-timeout': '120000',
      } : { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey! };
      const body = options.transport === 'gateway' ? {
        model: `google/${options.model ?? GEMINI_MODELS[0]}`, input: { text, voice: options.voice },
      } : {
        model: options.model ?? GEMINI_MODELS[0],
        input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: options.style ?? '' }] }] }],
        response_format: { type: 'audio', mime_type: 'audio/wav' },
        generation_config: { speech_config: [{ voice: options.voice }] }, store: false,
      };
      await beforeSend();
      let response: Response;
      try { response = await checkedFetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) }, true); }
      catch (error) {
        if (options.transport === 'gateway' && error instanceof SpeechRequestError && !error.outcomeUnknown) {
          if (error.message.includes('HTTP 402')) throw new SpeechRequestError('Cloudflareクレジット残高が不足しています（HTTP 402）。残高を確認してください。自動再送・Gemini直結への切替は行いません。');
          if (error.message.includes('HTTP 401') || error.message.includes('HTTP 403')) throw new SpeechRequestError('Cloudflare認証を確認してください。/ai/runにはWorkers AI Read権限が必要です（AI Gatewayのみの権限では実行できません）。自動再送は行いません。');
        }
        throw error;
      }
      try {
        const decoded: unknown = JSON.parse(Buffer.from(await boundedBytes(response, 90 * 1024 * 1024)).toString('utf8'));
        if (!decoded || typeof decoded !== 'object') throw new Error('invalid response');
        const payload = decoded as Record<string, unknown>;
        if (options.transport === 'gateway') {
          if ('success' in payload && payload.success !== true) throw new Error('Cloudflare error envelope');
          const result = 'result' in payload ? payload.result : payload;
          if (!result || typeof result !== 'object') throw new Error('invalid result');
          const data = result as Record<string, unknown>;
          const bytes = await cloudflareAudio(data.audio);
          captureReceipt?.(cloudflareReceipt(data, options, endpoint));
          return bytes;
        }
        const steps = payload.steps as Array<{ type?: string; content?: Array<{ type?: string; data?: string; mime_type?: string }> }> | undefined;
        const audio = steps?.filter((step) => step.type === 'model_output').flatMap((step) => step.content ?? []).filter((content) => content.type === 'audio').at(-1);
        if (!audio?.data || (audio.mime_type && audio.mime_type !== 'audio/wav')) throw new Error('invalid audio');
        const bytes = base64Wav(audio.data);
        captureReceipt?.(receipt(payload, options, endpoint));
        return bytes;
      } catch { throw new SpeechRequestError(`${options.transport === 'gateway' ? 'Cloudflareの音声応答' : 'Googleの音声応答'}を検証できませんでした。再送せず結果不明として保存します。`, true); }
    },
  };
}

/** Parse RIFF chunks instead of assuming a fixed 44-byte WAV header. */
export function wavDuration(bytes: Uint8Array): number {
  if (bytes.length < 44 || bytes.length > 64 * 1024 * 1024) throw new Error('WAV形式または容量が正しくありません。');
  const buffer = Buffer.from(bytes);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE' || buffer.readUInt32LE(4) + 8 !== bytes.length) throw new Error('WAV形式が正しくありません。');
  let byteRate = 0;
  let dataSize = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = buffer.readUInt32LE(offset + 4);
    const begin = offset + 8;
    if (begin + size > bytes.length) throw new Error('WAVが途中で切れています。');
    const type = buffer.toString('ascii', offset, offset + 4);
    if (type === 'fmt ' && size >= 16) {
      const format = buffer.readUInt16LE(begin);
      const channels = buffer.readUInt16LE(begin + 2);
      const sampleRate = buffer.readUInt32LE(begin + 4);
      byteRate = buffer.readUInt32LE(begin + 8);
      const blockAlign = buffer.readUInt16LE(begin + 12);
      const bits = buffer.readUInt16LE(begin + 14);
      if (format !== 1 || channels < 1 || channels > 2 || bits !== 16 || sampleRate < 8000 || sampleRate > 96000 || blockAlign !== channels * bits / 8 || byteRate !== sampleRate * blockAlign) throw new Error('対応するPCM WAVではありません。');
    }
    if (type === 'data') dataSize += size;
    offset = begin + size + (size % 2);
  }
  const duration = dataSize / byteRate;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 600) throw new Error('音声長を検証できません。');
  return duration;
}
