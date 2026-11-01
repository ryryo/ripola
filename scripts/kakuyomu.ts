/**
 * Kakuyomu adapter entry point for the CLI and focused parser tests.
 * The implementation lives in the web source so the local server and CLI
 * share one validated path. Upstream notice: docs/licenses/upstream/novel-downloader-LICENSE.
 */
export {
  assertAllowedKakuyomuUrl, extractEpisode, hash, kakuyomuEpisodeUrl, kakuyomuWorkUrl,
  parseNovelIndex, prepareNovelPart, requireEpisodeCanonical, requireWorkCanonical,
} from '../apps/web/src/kakuyomu/parser.ts';
export type {
  ExtractedParagraph, NovelEpisode, NovelIndex, NovelPart, RubyExpectation, SourceAccess,
} from '../apps/web/src/kakuyomu/parser.ts';
