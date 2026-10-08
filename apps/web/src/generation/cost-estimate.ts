import { GEMINI_MODELS, type GeminiModel, type GenerationOptions } from './contracts';

// Standard paid-tier prices verified 2026-10-07. No Batch/Flex/Priority discounts.
export const GEMINI_PRICING_SOURCE = 'https://ai.google.dev/gemini-api/docs/pricing';
export const GATEWAY_BILLING_SOURCE = 'https://developers.cloudflare.com/ai-gateway/features/unified-billing/';
export const GEMINI_PRICING_CHECKED = '2026-10-07';
export const ESTIMATED_CHARACTERS_PER_MINUTE = 400;
export const AUDIO_TOKENS_PER_SECOND = 25;
const ANNOUNCED_PRICE_CHANGE = Date.parse('2027-01-01T00:00:00Z');

export function estimateGeminiOutput(characters: number, model: GeminiModel = GEMINI_MODELS[0], at: Date = new Date()) {
  if (!Number.isSafeInteger(characters) || characters < 0) throw new Error('読み上げ文字数が正しくありません。');
  const multiplier = at.getTime() >= ANNOUNCED_PRICE_CHANGE ? 2 : 1;
  const outputUsdPerMillionTokens = (model === GEMINI_MODELS[1] ? 9 : 6) * multiplier;
  const inputUsdPerMillionTokens = 0.5 * multiplier;
  const estimatedSeconds = characters / ESTIMATED_CHARACTERS_PER_MINUTE * 60;
  return { characters, estimatedSeconds, estimatedAudioTokens: estimatedSeconds * AUDIO_TOKENS_PER_SECOND,
    estimatedOutputUsd: estimatedSeconds * AUDIO_TOKENS_PER_SECOND * outputUsdPerMillionTokens / 1_000_000,
    outputUsdPerMillionTokens, inputUsdPerMillionTokens, pricingPeriod: multiplier === 1 ? '2026-12-31まで' : '2027-01-01以降' };
}

export function geminiEstimateNote(transport: GenerationOptions['transport'], estimate: ReturnType<typeof estimateGeminiOutput>): string {
  return `${ESTIMATED_CHARACTERS_PER_MINUTE}文字/分・${AUDIO_TOKENS_PER_SECOND}音声token/秒を仮定。出力$${estimate.outputUsdPerMillionTokens}/100万音声token（${estimate.pricingPeriod}、料金確認${GEMINI_PRICING_CHECKED}）。入力$${estimate.inputUsdPerMillionTokens}/100万text token等は別途。実際の音声長と請求額は変わります。再生速度を変えても生成費用は変わりません。` + (transport === 'gateway' ? ' 課金先はGatewayの設定に従います。Unified Billingのクレジット購入時の5%手数料は含みません。' : ' Googleアカウントへの課金目安です。');
}
