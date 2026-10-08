import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireAudioPresentation } from '../apps/web/src/reader/audio-presentation';
import type { PlayableAudioBook } from '../apps/web/src/reader/audio-clock';
import { auditDistribution } from './distribution-utils.mjs';

export async function auditSavedAudioLibrary(root: string) {
  const results = [];
  for (const name of (await readdir(join(root, 'books'))).filter(name => name.endsWith('.json')).sort()) {
    try {
      const book = JSON.parse(await readFile(join(root, 'books', name), 'utf8')) as PlayableAudioBook & { presentation?: unknown };
      const report = requireAudioPresentation(book as Parameters<typeof requireAudioPresentation>[0]);
      results.push({ file: name, status: report.status, expectedUnits: report.expectedUnits, displayedUnits: report.displayedUnits,
        forcedAlignmentUnits: report.forcedAlignmentUnits, voicevoxUnits: report.voicevoxUnits, estimatedUnits: report.estimatedUnits,
        sourceBoundaryCheck: report.sourceBoundaryCheck, splitSourceUnits: report.splitSourceUnits, missing: report.missingUnitIds.length, duplicates: report.duplicateUnitIds.length,
        record: book.presentation ? 'stored-and-recomputed' : 'recomputed-legacy' });
    } catch (error) { results.push({ file: name, status: 'invalid', message: error instanceof Error ? error.message : 'Inspection unavailable' }); }
  }
  return { policy: 'all-source-phrases-v1', status: results.length && results.every(result => result.status === 'valid') ? 'valid' : 'invalid', books: results };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !['--library', '--distribution'].includes(args[0])) throw new Error('Usage: pnpm audit:audio --library <saved-library> OR --distribution <upload-directory>');
  if (args[0] === '--distribution') {
    const report = await auditDistribution(resolve(args[1]));
    console.log(JSON.stringify({ status: 'valid', audioBooks: report.audioBooks, files: report.fileCount, bytes: report.totalBytes, note: 'Every selected audio manifest was independently inspected; stored coverage reports are required.' }));
  } else {
    const report = await auditSavedAudioLibrary(resolve(args[1])); console.log(JSON.stringify(report)); if (report.status !== 'valid') process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : 'Audio presentation audit failed'); process.exitCode = 1; });
