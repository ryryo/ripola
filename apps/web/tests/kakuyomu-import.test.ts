import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractEpisode, kakuyomuWorkUrl, parseNovelIndex, prepareNovelPart,
  requireEpisodeCanonical, requireWorkCanonical,
} from '../../../scripts/kakuyomu.ts';
import { EPISODE_IDS, WORK_ID, WORK_URL, episodeHtml, episodeUrl, indexHtml, simpleBody, type TocFixture } from './helpers/kakuyomu-fixtures.ts';
import { kakuyomuWorkUrlInput } from '../src/kakuyomu/contracts';
import { readStoredUrlImportJob, URL_IMPORT_STORAGE_KEY } from '../src/kakuyomu/storage';

function index(records: TocFixture[] = [
  { heading: { level: 1, title: '第1章' }, episodes: [{ id: EPISODE_IDS[0], title: '第1話' }] },
]) { return parseNovelIndex(indexHtml({ records }), WORK_URL); }

test('Kakuyomu selects the requested work and rejects a public-count mismatch', () => {
  const value = index([{ heading: { level: 1, title: '第1章' }, episodes: [{ id: EPISODE_IDS[0], title: '第1話' }] }]);
  assert.equal(value.title, '検証用の作品');
  assert.equal(value.parts[0].title, '第1章');
  assert.equal(value.parts[0].episodes[0].url, episodeUrl(EPISODE_IDS[0]));
  assert.throws(() => parseNovelIndex(indexHtml({ publicEpisodeCount: 2, records: [{ heading: { level: 1, title: '第1章' }, episodes: [{ id: EPISODE_IDS[0], title: '第1話' }] }] }), WORK_URL), /話数/);
});

test('Kakuyomu keeps section state across headingless records and resets it on a new chapter', () => {
  const value = index([
    { heading: { level: 1, title: '第1章' }, episodes: [] },
    { heading: { level: 2, title: '第1節' }, episodes: [] },
    { omitChapter: true, episodes: [{ id: EPISODE_IDS[0], title: '第1話' }] },
    { omitChapter: true, episodes: [{ id: EPISODE_IDS[1], title: '第2話' }] },
    { heading: { level: 1, title: '第2章' }, episodes: [] },
    { omitChapter: true, episodes: [{ id: EPISODE_IDS[2], title: '第3話' }] },
    { heading: { level: 2, title: '第2節' }, episodes: [{ id: EPISODE_IDS[3], title: '第4話' }] },
  ]);
  assert.deepEqual(value.parts.map(part => part.title), ['第1章 第1節', '第2章', '第2章 第2節']);
  assert.deepEqual(value.parts.map(part => part.section), ['第1節', undefined, '第2節']);
  assert.deepEqual(value.parts[0].episodes.map(episode => episode.id), [EPISODE_IDS[0], EPISODE_IDS[1]]);
  assert.equal(value.parts.at(-1)!.episodes[0].order, 4);
});

test('Kakuyomu rejects unknown, missing and inconsistent hierarchy instead of flattening it', () => {
  const record = (heading: { level?: number | string; title?: unknown } | null) => ({ heading, episodes: [{ id: EPISODE_IDS[0], title: '第1話' }] });
  assert.throws(() => index([record({ level: 3, title: '第1章' })]), /階層/);
  assert.throws(() => index([record({ title: '第1章' })]), /階層/);
  assert.throws(() => index([record({ level: '1', title: '第1章' })]), /階層/);
  assert.throws(() => index([record({ level: 2, title: '第1節' })]), /章のない節/);
  assert.throws(() => index([record({ level: 1, title: '   ' })]), /目次見出し/);
  assert.throws(() => index([record({ level: 1, title: '第1章' }), record({ level: 2, title: '' })]), /目次見出し/);
});

test('Kakuyomu merges consecutive headingless records into one 本編 part', () => {
  const value = parseNovelIndex(indexHtml({ records: [
    { omitChapter: true, episodes: [{ id: EPISODE_IDS[0], title: '第1話' }] },
    { omitChapter: true, episodes: [{ id: EPISODE_IDS[1], title: '第2話' }] },
  ] }), WORK_URL);
  assert.equal(value.parts.length, 1);
  assert.equal(value.parts[0].title, '本編');
  assert.equal(value.parts[0].chapter, '');
  assert.equal(value.parts[0].episodes.length, 2);
});

test('Kakuyomu rejects private, duplicate and unknown episode entries', () => {
  const episode = { id: EPISODE_IDS[0], title: '第1話' };
  assert.throws(() => parseNovelIndex(indexHtml({ nextWork: { __ref: 'Work:next' }, records: [{ heading: { level: 1, title: '第1章' }, episodes: [episode] }] }), WORK_URL), /公開作品/);
  assert.throws(() => index([{ heading: { level: 1, title: '第1章' }, episodes: [episode, episode] }]), /重複/);
  assert.throws(() => index([{ heading: { level: 1, title: '第1章' }, anyType: 'Work', episodes: [episode] }]), /非公開/);
});

test('the URL field accepts only an explicit work URL', () => {
  assert.equal(kakuyomuWorkUrlInput(WORK_URL), WORK_URL);
  assert.equal(kakuyomuWorkUrlInput(`  ${WORK_ID}  `), undefined);
  assert.equal(kakuyomuWorkUrlInput('12345678901234567890'), undefined);
  assert.equal(kakuyomuWorkUrlInput(`${WORK_URL}/`), WORK_URL);
  assert.equal(kakuyomuWorkUrlInput(`この作品は ${WORK_URL} です`), undefined);
  assert.equal(kakuyomuWorkUrlInput(`${WORK_URL}/episodes/${EPISODE_IDS[0]}`), undefined);
  assert.equal(kakuyomuWorkUrlInput('https://example.test/works/' + WORK_ID), undefined);
  assert.equal(kakuyomuWorkUrlInput(''), undefined);
});

test('a stored URL import record is read only when it has a job id and work URL', () => {
  const valid = readStoredUrlImportJob({ getItem: key => key === URL_IMPORT_STORAGE_KEY ? JSON.stringify({ jobId: 'job-1', url: WORK_URL }) : null });
  assert.deepEqual(valid, { jobId: 'job-1', url: WORK_URL });
  assert.equal(readStoredUrlImportJob({ getItem: () => '{' }), undefined);
  assert.equal(readStoredUrlImportJob({ getItem: () => JSON.stringify({ jobId: 'job-1' }) }), undefined);
  assert.equal(readStoredUrlImportJob({ getItem: () => null }), undefined);
});

test('Kakuyomu URL validation is exact and allows the old tableOfContents key', () => {
  assert.equal(kakuyomuWorkUrl(WORK_ID), WORK_URL);
  for (const input of [`http://kakuyomu.jp/works/${WORK_ID}`, `${WORK_URL}?token=x`, `${WORK_URL}/episodes/${EPISODE_IDS[0]}`, `https://kakuyomu.jp.evil.test/works/${WORK_ID}`]) assert.throws(() => kakuyomuWorkUrl(input));
  const old = parseNovelIndex(indexHtml({ tocKey: 'old', records: [{ heading: { level: 1, title: '第1章' }, episodes: [{ id: EPISODE_IDS[0], title: '第1話' }] }] }), WORK_URL);
  assert.equal(old.parts.length, 1);
});

test('ruby base ranges and readings are checked independently from the rendered Markdown', () => {
  const [paragraph] = extractEpisode(episodeHtml('<p>　<ruby><rb>漢</rb><rp>（</rp><rt>かん</rt><rp>）</rp></ruby>字</p>', EPISODE_IDS[0]));
  assert.equal(paragraph.text, '　漢字');
  assert.deepEqual(paragraph.ruby, [{ start: 1, end: 2, reading: 'かん' }]);
  const [wide] = extractEpisode(episodeHtml('<p><ruby>漢字<rt>かんじ</rt></ruby></p>', EPISODE_IDS[0]));
  assert.deepEqual(wide.ruby, [{ start: 0, end: 2, reading: 'かんじ' }]);
});

test('ruby whose range cannot be represented fails instead of widening or dropping text', () => {
  for (const body of [
    '<p><ruby>漢<rt>かん</rt>字</ruby></p>',
    '<p><ruby>字<rt>じ</rt> </ruby></p>',
    '<p><ruby>字<rt>じ</rt><rt>し</rt></ruby></p>',
    '<p><ruby>字<rt><span>じ</span></rt></ruby></p>',
    '<p><ruby>字<rt></rt></ruby></p>',
    '<p><ruby>字<rt> じ </rt></ruby></p>',
    '<p><ruby><ruby>字<rt>じ</rt></ruby><rt>し</rt></ruby></p>',
    '<p><ruby><rb>字</rb><rb>詞</rb><rt>じ</rt></ruby></p>',
  ]) assert.throws(() => extractEpisode(episodeHtml(body, EPISODE_IDS[0])), /ルビ/);
});

test('unknown body structure and ruby children fail closed', () => {
  for (const body of [
    '<p>本文</p><img src="example.png" alt="挿絵">',
    '<section><p>本文</p></section>',
    '<p>本文</p>未取得',
    '<p><script>unsafe()</script>本文</p>',
    '<p><ruby>字<rt>じ</rt><script>unsafe()</script></ruby></p>',
  ]) assert.throws(() => extractEpisode(episodeHtml(body, EPISODE_IDS[0])), /本文|段落|未対応|ルビ/);
});

test('known inline decoration and br preserve visible source order', () => {
  const [paragraph] = extractEpisode(episodeHtml('<p><span><em>強調</em></span>と<br>改行</p>', EPISODE_IDS[0]));
  assert.equal(paragraph.text, '強調と\n改行');
  assert.equal(paragraph.markdown, '強調と  \n改行');
});

test('canonical validation uses the parsed head DOM, not a regular expression', () => {
  assert.doesNotThrow(() => requireEpisodeCanonical(`<html><head><link href="${episodeUrl(EPISODE_IDS[0])}" rel="canonical"></head></html>`, episodeUrl(EPISODE_IDS[0])));
  assert.doesNotThrow(() => requireWorkCanonical(`<html><head><link rel="canonical" href="${WORK_URL}"></head></html>`, WORK_URL));
  assert.throws(() => requireEpisodeCanonical(`<html><head><!-- <link rel="canonical" href="${episodeUrl(EPISODE_IDS[0])}"> --><link rel="canonical" href="${episodeUrl(EPISODE_IDS[1])}"></head></html>`, episodeUrl(EPISODE_IDS[0])), /canonical/);
  assert.throws(() => requireEpisodeCanonical(`<html><head><link rel="canonical" href="${episodeUrl(EPISODE_IDS[0])}"><link rel="canonical" href="${episodeUrl(EPISODE_IDS[1])}"></head></html>`, episodeUrl(EPISODE_IDS[0])), /canonical/);
  assert.throws(() => requireEpisodeCanonical(`<html><head></head><body><link rel="canonical" href="${episodeUrl(EPISODE_IDS[0])}"></body></html>`, episodeUrl(EPISODE_IDS[0])), /canonical/);
  assert.throws(() => requireEpisodeCanonical(`<html><head><link rel="canonical" href="https://evil.test/works/${WORK_ID}/episodes/${EPISODE_IDS[0]}"></head></html>`, episodeUrl(EPISODE_IDS[0])), /canonical/);
  assert.throws(() => requireEpisodeCanonical(`<html><head><link rel="canonical" href="${episodeUrl(EPISODE_IDS[0])}?x=1"></head></html>`, episodeUrl(EPISODE_IDS[0])), /canonical/);
});

test('prepareNovelPart compares every block and ruby span with the source HTML', () => {
  const value = index([{ heading: { level: 1, title: '第1章' }, episodes: [{ id: EPISODE_IDS[0], title: '第1話' }] }]);
  const raw = episodeHtml(simpleBody, EPISODE_IDS[0]);
  const prepared = prepareNovelPart(value, value.parts[0], new Map([[EPISODE_IDS[0], raw]]));
  assert.equal(prepared.draft.blocks[3].text, '　試験と本文。');
  assert.deepEqual(prepared.draft.blocks[3].ruby.map(span => ({ start: span.start, end: span.end, reading: span.reading })), [{ start: 1, end: 3, reading: 'しけん' }]);
  assert.equal(prepared.ruby, 1);
  const mapping = prepared.mapping as { episodes: Array<{ paragraphs: Array<{ ruby: unknown[] }>; exclusions: number[][] }> };
  assert.deepEqual(mapping.episodes[0].paragraphs[0].ruby, [{ start: 1, end: 3, reading: 'しけん' }]);
  assert.ok(mapping.episodes[0].exclusions.length > 0);
});

test('prepareNovelPart never accepts the historical post-rt base scope widening', () => {
  const value = index([{ heading: { level: 1, title: '第1章' }, episodes: [{ id: EPISODE_IDS[0], title: '第1話' }] }]);
  const raw = episodeHtml('<p><ruby>漢<rt>かん</rt>字</ruby></p>', EPISODE_IDS[0]);
  assert.throws(() => prepareNovelPart(value, value.parts[0], new Map([[EPISODE_IDS[0], raw]])), /ルビ/);
});

test('missing body, nonparagraph text and unsafe elements fail instead of importing unrelated content', () => {
  assert.throws(() => extractEpisode('<div><p>広告だけ</p></div>'), /公開本文/);
  assert.throws(() => extractEpisode('<div class="widget-episodeBody"><p>本文</p>未取得の末尾</div>'), /段落外/);
  assert.throws(() => extractEpisode('<div class="widget-episodeBody"><p>本文<script>unsafe()</script></p></div>'), /未対応/);
});
