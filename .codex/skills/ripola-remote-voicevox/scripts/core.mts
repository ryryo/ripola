import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

/** Load the selected checkout, rather than a private task's relative imports. */
export async function loadCore(repo: string) {
  const load = (path: string) => import(pathToFileURL(join(repo, path)).href);
  return Object.assign({}, ...await Promise.all([
    'apps/web/src/reader/segmentation.ts', 'apps/web/src/reader/text-import.ts',
    'apps/web/src/reader/audio-presentation.ts', 'apps/web/src/generation/core/service.ts',
    'apps/web/src/generation/core/disk.ts', 'apps/web/src/generation/core/audio-cache.ts',
    'apps/web/src/generation/core/providers.ts', 'apps/web/src/generation/core/audio-cleanup.ts',
    'apps/web/src/generation/core/audio-compression.ts',
    'apps/web/src/generation/audio-quality/service.ts',
  ].map(load)));
}
