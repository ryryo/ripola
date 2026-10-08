import { useEffect, useState } from 'react';
import type { DraftDocument } from '../reader/model';
import type { GeminiModel, GenerationOptions, ReadingOverride } from '../generation/contracts';
import { AUDIO_TOKENS_PER_SECOND, ESTIMATED_CHARACTERS_PER_MINUTE, estimateGeminiOutput, GEMINI_PRICING_CHECKED, GEMINI_PRICING_SOURCE, GATEWAY_BILLING_SOURCE } from '../generation/cost-estimate';
import type { EstimateRange } from '../generation/cost-source';

interface Props {
  raw: string; format: 'txt' | 'md'; document?: Pick<DraftDocument, 'blocks'>;
  readings: ReadingOverride[]; readingsError?: string; ranges?: EstimateRange[];
  model: GeminiModel; transport: GenerationOptions['transport'];
}
type Result = Pick<Props, 'raw' | 'format' | 'document' | 'readings' | 'ranges'> & { characters?: number; error?: string };

export function GeminiCostPreview(props: Props) {
  const { raw, format, document, readings, readingsError, ranges, model, transport } = props;
  const [result, setResult] = useState<Result>();
  useEffect(() => {
    if (readingsError) return;
    let worker: Worker | undefined;
    let active = true;
    const input = { raw, format, document, readings, ranges };
    const timer = window.setTimeout(() => {
      try {
        worker = new Worker(new URL('./cost-worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<{ characters?: number; error?: string }>) => {
          if (active) setResult({ ...input, ...event.data });
          worker?.terminate();
        };
        worker.onerror = event => { event.preventDefault(); if (active) setResult({ ...input, error: '文字数を計算できませんでした。再読み込みしてお試しください。' }); worker?.terminate(); };
        worker.postMessage({ ...input, document: document ? { blocks: document.blocks } : undefined });
      } catch { if (active) setResult({ ...input, error: '費用目安を計算できませんでした。' }); }
    }, 200);
    return () => { active = false; window.clearTimeout(timer); worker?.terminate(); };
  }, [raw, format, document, readings, readingsError, ranges]);
  const current = result?.raw === raw && result.format === format && result.document === document && result.readings === readings && result.ranges === ranges ? result : undefined;
  const error = readingsError ?? current?.error;
  const estimate = current?.characters !== undefined ? estimateGeminiOutput(current.characters, model) : undefined;
  const roundedSeconds = estimate ? Math.round(estimate.estimatedSeconds) : 0;
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  const duration = estimate ? `${minutes}分${String(seconds).padStart(2, '0')}秒` : '';
  return <section className="gemini-cost-preview" data-testid="gemini-cost-estimate" role="region" aria-label="Gemini費用の目安">
    <div className="cost-preview-heading"><strong>生成費用の目安</strong><span>{model.includes('lite') ? 'Flash-Lite' : 'Flash'} · USD</span></div>
    <div className="cost-preview-value" aria-live="polite" aria-atomic="true">{error ? <p>{error}</p> : estimate ? <><strong data-testid="cost-output">${estimate.estimatedOutputUsd.toFixed(4)}</strong><span>音声出力分 + 入力料金等</span><p><span data-testid="cost-characters">読み上げ {estimate.characters.toLocaleString()}文字</span> · 音声 約{duration}</p></> : <p>読み上げ文字数を計算しています…</p>}</div>
    <p className="cost-preview-note">{ranges ? '選択した文' : '本文全体'}を新規生成した場合の目安です。保存音声の再利用は「生成内容を確認する」で差し引きます。</p>
    <details><summary>計算条件と料金</summary><p>{ESTIMATED_CHARACTERS_PER_MINUTE}文字/分・{AUDIO_TOKENS_PER_SECOND}音声token/秒を仮定。{estimate && <>出力 ${estimate.outputUsdPerMillionTokens} / 100万音声token、入力 ${estimate.inputUsdPerMillionTokens} / 100万text token（{estimate.pricingPeriod}）。</>} 文字数はルビの読み・読み辞書を反映し、Markdownの記号・コード・表を除きます。</p><p>話す速さや間で音声の長さが変わり、実際の請求額は異なります。再生速度を変えても生成費用は変わりません。</p><p>{transport === 'direct' ? 'Googleアカウントへの課金目安です。' : <>課金先はGatewayの設定に従います。Unified Billingのクレジット購入時の5%手数料は含みません。 <a href={GATEWAY_BILLING_SOURCE} target="_blank" rel="noreferrer">Cloudflare料金</a></>}</p><p>料金確認：{GEMINI_PRICING_CHECKED} · <a href={GEMINI_PRICING_SOURCE} target="_blank" rel="noreferrer">Google公式料金</a></p></details>
  </section>;
}
