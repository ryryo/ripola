import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractEpisode, kakuyomuWorkUrl, parseNovelIndex, prepareNovelPart, hash } from './kakuyomu.ts';
import { openKakuyomuCache } from '../apps/web/src/kakuyomu/cache.ts';
import { SequentialKakuyomuFetcher, type PageFetch } from '../apps/web/src/kakuyomu/fetch.ts';
import { MAX_TEXT_BOOK_BYTES } from '../apps/web/src/kakuyomu/text-books.ts';
import { prepareDocument } from '../apps/web/src/reader/segmentation.ts';

async function main() {
  const args = process.argv.slice(2), input = args.shift();
  const flags = new Map<string, string>();
  let offline = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--offline') { offline = true; continue; }
    if (!['--output', '--parts', '--cache'].includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new Error('Unknown or repeated option.');
    flags.set(args[i], args[++i]);
  }
  if (!input || !flags.get('--output')) throw new Error('Usage: pnpm import:kakuyomu WORK_URL --output local-inputs/WORK [--parts 1,2] [--offline] [--cache DIR]');
  const url = kakuyomuWorkUrl(input), output = resolve(flags.get('--output')!);
  const repository = resolve(import.meta.dirname, '..');
  if (output === repository || output.startsWith(repository + '/') && !output.startsWith(join(repository, 'local-inputs') + '/')) throw new Error('作品はGit対象外のlocal-inputs配下、またはリポジトリ外へ保存してください。');
  const cacheRoot = resolve(flags.get('--cache') ?? join(output, 'raw'));
  await mkdir(output, { recursive: true });
  // Existing numeric trial caches are adopted only at their current hash after
  // canonical/URL checks; later reads re-check the recorded hash and byte count.
  const cache = openKakuyomuCache(cacheRoot, url, { allowLegacyAdoption: true, maxBytes: 3_000_000 });
  const fetcher = new SequentialKakuyomuFetcher({ minIntervalMs: 1200, timeoutMs: 30_000, maxBytes: 3_000_000 });
  const fetchPage: PageFetch = (url, access) => fetcher.fetch(url, access);
  const page = await cache.getIndex(fetchPage, offline);
  const index = parseNovelIndex(page.html, url);
  const selected = flags.get('--parts')?.split(',').map(Number);
  if (selected && (new Set(selected).size !== selected.length || selected.some(n => !Number.isInteger(n) || n < 1 || n > index.parts.length))) throw new Error('章・節番号が正しくありません。');
  const reports = [];
  const save = async (file: string, value: string) => {
    const destination = join(output, file);
    try {
      if (await readFile(destination, 'utf8') === value) return;
      throw new Error(`既存の出力と内容が異なります。新しい出力先を指定してください: ${file}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Complete a private temporary file, then link it exclusively to the final
    // name so an interrupted run never leaves a partial artifact.
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    try { await link(temporary, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && await readFile(destination, 'utf8') === value) { /* Same bytes already published. */ }
      else throw error;
    } finally { await unlink(temporary).catch(() => undefined); }
  };
  for (const part of index.parts.filter(part => !selected || selected.includes(part.order))) {
    const html = new Map<string, string>();
    for (const episode of part.episodes) {
      const episodePage = await cache.getEpisode(episode, fetchPage, offline);
      // Validate the body immediately, before continuing to later episodes.
      extractEpisode(episodePage.html);
      html.set(episode.id, episodePage.html);
    }
    const { draft, mapping, ruby } = prepareNovelPart(index, part, html);
    const document = await prepareDocument(draft);
    const documentJson = JSON.stringify(document) + '\n';
    if (new TextEncoder().encode(documentJson).byteLength > MAX_TEXT_BOOK_BYTES) throw new Error('生成本文が25 MiBを超えています。章・節を分けて取得してください。');
    const stem = `${String(part.order).padStart(2, '0')}-${index.id}`;
    await save(`${stem}.md`, draft.rawText);
    await save(`${stem}.document.json`, documentJson);
    await save(`${stem}.source-map.json`, JSON.stringify(mapping, null, 2) + '\n');
    const report = { order: part.order, title: document.title, episodes: part.episodes.length,
      firstEpisode: part.episodes[0].order, lastEpisode: part.episodes.at(-1)!.order,
      characters: document.totalCharacters, ruby, markdown: `${stem}.md`, document: `${stem}.document.json`,
      id: `text-kakuyomu-${index.id}-${String(part.order).padStart(2, '0')}`, revision: document.contentHash, sourceSha256: hash(draft.rawText) };
    reports.push(report); console.log(JSON.stringify(report));
  }
  await save(`import-report-${reports.map(r => r.order).join('-')}.json`, JSON.stringify({ source: index.url, author: index.author, parts: reports, audioGenerated: false, published: false }, null, 2) + '\n');
}
main().catch(error => { console.error(error instanceof Error ? error.message : '取り込みに失敗しました。'); process.exitCode = 1; });
