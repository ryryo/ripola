import type { ChunkPlannerPolicy } from '../../src/generation/core/chunk-planner.ts';

/** Self-authored text; no upstream book, real voice, or speech model needed. */
export const plannerFixtures = [
  { id: 'ordinary-paste', text: '朝、窓を開けた。遠くで鳥が鳴いている。机に本を置き、昨日の続きを読む。急いで結論を探さず、言葉の流れをたどる。少し休んだら、気になったところをノートに書こう。' },
  { id: 'many-short-sentences', text: '朝だ。晴れた。本を開く。読む。考える。窓を見る。風が吹く。頁をめくる。続きを読む。休む。水を飲む。戻る。' },
  { id: 'numbers-and-english', text: '2026年10月12日の10:30に、1,200円の本を買った。Version v2.1 is ready. The API returns 3.14, then saves report_2026.json. 残りは１２．５％だった。連絡先は reader@example.test で、案内は https://example.test/path?q=12.5 にある。' },
  { id: 'long-clause', text: '帰り道には、街灯の下で立ち止まり、遠い山を眺めながら、朝に読んだ物語の続きを思い出し、まだ名前のない登場人物の気持ちを考え、道の向こうにある小さな店を見つけて、温かい飲み物を一杯だけ買ってから、ゆっくりと家に帰ることにした。' },
  { id: 'quotes-and-lines', text: '「急がなくていい。\n順番に読もう」と彼は言った。（机の上には、本と鉛筆がある。）\r\n\r\n次の頁には「窓を開ける、そして空を見る」と書かれていた。\n続きは明日にする。' },
  { id: 'unicode', text: 'か\u3099くせいは、葛\u{E0100}の葉を観察した。👩🏽‍💻と家族の絵文字👨‍👩‍👧‍👦を並べ、🇯🇵を添えた。Cafe\u0301で資料を読み、𠮷の字も書き留めた。' },
  { id: 'no-punctuation', text: '静かな道を歩きながら昨日読んだ物語の続きを思い出す'.repeat(180) },
  { id: 'long-ascii-token', text: 'https://example.test/' + 'abcdefghij1234567890'.repeat(170) },
];

export const fixturePolicy: ChunkPlannerPolicy = {
  version: 'fixture-voicevox-v1',
  hard: { maxCharacters: 3000, maxEstimatedSeconds: 45 },
  soft: { targetSeconds: 12, minimumSeconds: 4, preferredMaxSeconds: 18 },
  requestCost: 8,
  estimatedRequestOverheadSeconds: 0.5,
};
