import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanupSavedWavs } from '../apps/web/src/generation/core/audio-cleanup.ts';
import { digest, LibraryDisk, requireId } from '../apps/web/src/generation/core/disk.ts';

async function main() {
  const args = process.argv.slice(2), flags = new Map<string, string>(); let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') { apply = true; continue; }
    if (!['--config', '--report', '--operation'].includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new Error('Usage: pnpm cleanup:audio --config selection.json --report new-report.json --operation ID [--apply]');
    flags.set(args[i], args[++i]);
  }
  if (!flags.has('--config') || !flags.has('--report') || !flags.has('--operation')) throw new Error('Explicit selection, new report and operation ID are required.');
  const operation = requireId(flags.get('--operation'));
  const config = JSON.parse(await readFile(resolve(flags.get('--config')!), 'utf8')) as { libraryDir: string; books: Array<{ id: string; revision: string }> };
  if (typeof config.libraryDir !== 'string' || !config.libraryDir.trim() || !Array.isArray(config.books) || !config.books.length) throw new Error('Explicit libraryDir and selected books are required.');
  const reportPath = resolve(flags.get('--report')!);
  // Reserve an immutable report destination before changing audio; never overwrite an earlier record.
  await writeFile(reportPath, JSON.stringify({ status: 'running', applied: apply, books: [] }), { flag: 'wx', mode: 0o600 });
  const books = [];
  try {
    for (const book of config.books) {
      const report = await cleanupSavedWavs(new LibraryDisk(resolve(config.libraryDir)), { bookId: book.id, revision: book.revision,
        operationId: digest(`${operation}:${book.id}:${book.revision}`), apply });
      books.push(report);
      await writeFile(reportPath, JSON.stringify({ status: 'running', applied: apply, books }, null, 2) + '\n');
    }
    const uniqueFiles = (status: string) => [...new Map(books.flatMap(b => b.files).filter(f => f.status === status).map(f => [f.speechKey, f])).values()];
    const summary = { status: books.every(b => b.status === 'completed') ? 'completed' : 'partial', applied: apply,
      books: books.length, removedFiles: uniqueFiles('removed').length, removedWavBytes: uniqueFiles('removed').reduce((n, f) => n + f.bytes, 0),
      plannedFiles: uniqueFiles('planned').length,
      plannedBytes: uniqueFiles('planned').reduce((n, f) => n + f.bytes, 0), retainedWavFiles: [...new Set(books.flatMap(b => b.files).filter(f => ['retained', 'in-use', 'failed'].includes(f.status)).map(f => f.speechKey))].length };
    await writeFile(reportPath, JSON.stringify({ ...summary, reports: books }, null, 2) + '\n'); console.log(JSON.stringify(summary));
    if (books.some(b => b.files.some(f => f.status === 'failed'))) process.exitCode = 1;
  } catch (error) {
    await writeFile(reportPath, JSON.stringify({ status: 'failed', applied: apply, books, error: error instanceof Error ? error.message : 'Cleanup failed' }, null, 2) + '\n'); throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : 'Cleanup failed'); process.exitCode = 1; });
