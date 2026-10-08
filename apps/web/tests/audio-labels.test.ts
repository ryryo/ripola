import assert from 'node:assert/strict';
import { test } from 'node:test';
import { audioAlignmentWarning, audioFallbackMessage } from '../src/reader/audio-labels.ts';

test('alignment reason codes become useful Japanese without echoing an internal path or error', () => {
  assert.match(audioFallbackMessage('low-ctc-score'), /確かさが低い/);
  assert.match(audioFallbackMessage('unmatched-transcript'), /原稿と読み上げ/);
  assert.match(audioFallbackMessage('silence-or-too-quiet'), /無音/);
  assert.doesNotMatch(audioFallbackMessage('採用できるフレーズだけを表示します。無音・読み不一致・低スコアは文単位です。'), /無音/);
  assert.match(audioFallbackMessage('補正後のcueが重なるため、文単位で表示します。'), /時刻の対応/);
  const privateError = '/private/local-model/cache: internal-runtime-error';
  assert.equal(audioFallbackMessage(privateError), 'この部分のフレーズ時刻を確定できないため、表示用の推定時刻を使います。');
  assert.doesNotMatch(audioFallbackMessage(privateError), /private|runtime/);
  assert.match(audioAlignmentWarning('CTC scoreは時刻精度の確率ではありません。'), /時刻精度を保証する確率ではありません/);
});
