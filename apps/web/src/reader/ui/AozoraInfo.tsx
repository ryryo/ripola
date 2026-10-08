import type { AozoraProvenance } from '../model';
export function AozoraInfo({ value }: { value?: AozoraProvenance }) {
  if (!value) return null;
  return <details className="aozora-provenance"><summary>作品の出典・ルビ・外字・入力者注</summary>
    <p>{value.author}『{value.title}』。歴史的な表現を含みます。原資料の表記を保っています。</p>
    <p>{value.sourceUrl && <a href={value.sourceUrl} target="_blank" rel="noreferrer">青空文庫の原文</a>} {value.cardUrl && <a href={value.cardUrl} target="_blank" rel="noreferrer">図書カード</a>}</p>
    <p>元資料にはルビ{value.counts.ruby.toLocaleString()}件、外字画像{value.counts.gaiji}件、入力者注{value.counts.notes}件。外字は〓で表示し、読みがない説明文は読み上げません。「ママ」などの注記ルビは発音に使いません。</p>
    <h3>書誌と作成者</h3><pre>{value.bibliography}</pre><h3>表記について</h3><pre>{value.notationNotes}</pre>
    <details><summary>保存した外字と入力者注（{value.annotations.length}件）</summary><ul>{value.annotations.map((note, index) => <li key={index}>{note.kind === 'gaiji' ? '外字' : '注'}：{note.text}（原HTMLの文字位置 {note.source.start}–{note.source.end}）</li>)}</ul></details>
    <p>本文と配布音声の条件はそれぞれの出典に従います。図書カードの書誌データは青空文庫の<a href="https://www.aozora.gr.jp/guide/kijyunn.html" target="_blank" rel="noreferrer">利用案内</a>に基づく<a href="https://creativecommons.org/licenses/by/4.0/deed.ja" target="_blank" rel="noreferrer">CC BY 4.0</a>として出典を表示しています。</p>
  </details>;
}
