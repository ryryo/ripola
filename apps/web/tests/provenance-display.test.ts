import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AozoraInfo } from '../src/reader/ui/AozoraInfo';
import type { AozoraProvenance } from '../src/reader/model';

test('web novel provenance never claims Aozora or Creative Commons licensing', () => {
  // The root tsx test runner uses the classic JSX factory; Vite uses automatic JSX.
  Object.assign(globalThis, { React });
  const value: AozoraProvenance = { title: '検証原稿', author: '検証著者', sourceUrl: 'https://kakuyomu.jp/works/12345678901234567890',
    bibliography: '検証書誌', notationNotes: '原文保持', counts: { ruby: 2, gaiji: 0, notes: 0 }, chapters: [], annotations: [] };
  const general = renderToStaticMarkup(React.createElement(AozoraInfo, { value }));
  assert.match(general, /掲載元の原文/); assert.doesNotMatch(general, /青空文庫|CC BY|歴史的な表現/);
  const aozora = renderToStaticMarkup(React.createElement(AozoraInfo, { value: { ...value, sourceUrl: 'https://www.aozora.gr.jp/cards/1/files/1.html' } }));
  assert.match(aozora, /青空文庫の原文/); assert.match(aozora, /CC BY 4.0/);
});
