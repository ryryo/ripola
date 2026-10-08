/** Never echo an internal reason, tool error or local path in the reading flow. */
export function audioFallbackMessage(reason?: string): string {
  if (!reason || /未整列|forced alignmentがありません|no-alignment/i.test(reason)) return 'この音声にはフレーズ時刻がまだありません。';
  if (/some-units-unreliable|採用できるフレーズだけ/.test(reason)) return 'この部分のフレーズ時刻を確定できないため、表示用の推定時刻を使います。';
  if (/punctuation-or-silence/i.test(reason)) return '句読点や音声の間にあたるため、表示用の推定時刻を使います。';
  if (/silence|too-quiet|無音|非常に小さい/i.test(reason)) return '無音または非常に小さい音声のため、時刻を確定できませんでした。';
  if (/unmatched-transcript|reading-mismatch|読み.*一致|既知原稿.*経路/i.test(reason)) return '原稿と読み上げが十分に一致せず、時刻を確定できませんでした。';
  if (/shared-reading-unreliable/i.test(reason)) return '複数のフレーズにまたがる読みの時刻を確定できませんでした。';
  if (/low-ctc-score|low-score|採用.*score/i.test(reason)) return 'フレーズ時刻の確かさが低いため、表示用の推定時刻を使います。';
  if (/overlapping-unit-times|位置や時刻|補正後.*重な|PCM|AAC/i.test(reason)) return '保存音声との時刻の対応を確かめられないため、表示用の推定時刻を使います。';
  return 'この部分のフレーズ時刻を確定できないため、表示用の推定時刻を使います。';
}

export function audioAlignmentWarning(warning: string): string {
  if (/VOICEVOX.*再構成/.test(warning)) return 'VOICEVOXのqueryを再構成した推定です。元queryとの同一性と実際の発話境界の精度は未確認です。';
  if (/VOICEVOX.*(?:音素|query)/.test(warning)) return 'VOICEVOXの音素時刻を使います。人手で測った発話境界の誤差は未測定です。';
  if (/確率/.test(warning)) return '整列のスコアは選別の指標で、時刻精度を保証する確率ではありません。';
  if (/上限|runtime-size-limit/.test(warning)) return '整列できる音声の長さの上限を超えています。対応しない部分は表示用の推定時刻を使います。';
  if (/モデル語彙|unknown-vocabulary/.test(warning)) return '整列に対応しない文字があるため、その部分は表示用の推定時刻を使います。';
  return audioFallbackMessage(warning);
}
