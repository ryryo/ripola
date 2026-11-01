export const WORK_ID = '12345678901234567890';
export const WORK_URL = `https://kakuyomu.jp/works/${WORK_ID}`;
export const EPISODE_IDS = ['16816927863114624643', '16816927863114704363', '16816927863114766773', '16816927863114831110'];
export function episodeUrl(id: string): string { return `${WORK_URL}/episodes/${id}`; }

export interface EpisodeFixture { id: string; title: string }
export interface TocFixture {
  heading?: { level?: number | string; title?: unknown } | null;
  episodes?: EpisodeFixture[];
  anyType?: string;
  omitChapter?: boolean;
}
export interface IndexFixture {
  title?: string;
  author?: string;
  records: TocFixture[];
  publicEpisodeCount?: number;
  nextWork?: unknown;
  tocKey?: 'v2' | 'old';
}

export function indexHtml(fixture: IndexFixture): string {
  const state: Record<string, unknown> = {
    [`Work:${WORK_ID}`]: {
      __typename: 'Work', id: WORK_ID, title: fixture.title ?? '検証用の作品', author: { __ref: 'Author:1' },
      publicEpisodeCount: fixture.publicEpisodeCount ?? fixture.records.reduce((sum, record) => sum + (record.episodes?.length ?? 0), 0),
      ...(fixture.nextWork !== undefined ? { kakuyomuNextWork: fixture.nextWork } : {}),
      [(fixture.tocKey === 'old' ? 'tableOfContents' : 'tableOfContentsV2')]: fixture.records.map((_, index) => ({ __ref: `Toc:${index}` })),
    },
    'Author:1': { activityName: '検証用著者', name: '検証用著者' },
  };
  fixture.records.forEach((record, index) => {
    const toc: Record<string, unknown> = { episodeUnions: (record.episodes ?? []).map(episode => ({ __ref: `Episode:${episode.id}` })) };
    if (!record.omitChapter) {
      toc.chapter = { __ref: `Chapter:${index}` };
      state[`Chapter:${index}`] = { ...(record.heading?.level === undefined ? {} : { level: record.heading.level }), title: record.heading?.title ?? `第${index + 1}章` };
    }
    state[`Toc:${index}`] = toc;
    for (const episode of record.episodes ?? []) {
      state[`Episode:${episode.id}`] = { __typename: record.anyType ?? 'Episode', id: episode.id, title: episode.title };
    }
  });
  return `<html><head><link rel="canonical" href="${WORK_URL}"></head><body><script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { __APOLLO_STATE__: state } } })}</script></body></html>`;
}

export function episodeHtml(body: string, id: string, options: { canonical?: string; extraHead?: string; bodyClass?: string } = {}): string {
  const canonical = options.canonical ?? episodeUrl(id);
  return `<!doctype html><html><head><meta charset="utf-8"><link href="${canonical}" rel="canonical">${options.extraHead ?? ''}</head><body><nav><p>ナビ</p></nav><div class="${options.bodyClass ?? 'widget-episodeBody js-episode-body'}">${body}</div><footer><p>広告</p></footer></body></html>`;
}

export const simpleBody = '<p>　<ruby><rb>試験</rb><rp>（</rp><rt>しけん</rt><rp>）</rp></ruby>と本文。</p><p>次の段落。</p>';
