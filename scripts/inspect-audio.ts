import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadGenerationConfig } from '../apps/web/src/generation/core/config';
import { LibraryDisk } from '../apps/web/src/generation/core/disk';
import { AudioInspectionService } from '../apps/web/src/generation/audio-quality/service';
import { localReazonAsr } from '../apps/web/src/generation/audio-quality/runtime';

export async function inspectionCli(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { library: { type: 'string' }, book: { type: 'string' }, revision: { type: 'string' }, chunks: { type: 'string' }, content: { type: 'boolean' }, refresh: { type: 'boolean' }, read: { type: 'boolean' } } });
  if (!values.book || !values.revision) throw new Error('Usage: node --import tsx scripts/inspect-audio.ts --book ID --revision SHA [--library DIR] [--chunks ID,ID] [--content] [--refresh] [--read]');
  const config = await loadGenerationConfig();
  const service = new AudioInspectionService(new LibraryDisk(values.library ? resolve(values.library) : config.libraryDir), localReazonAsr(config));
  const result = values.read ? await service.read(values.book, values.revision) : await service.inspect({ bookId: values.book, revision: values.revision, selectedChunkIds: values.chunks?.split(','), content: values.content, refresh: values.refresh });
  if (!result) throw new Error('現在の音声hashに対応する検査結果がありません。');
  console.log(JSON.stringify(result, null, 2));
  // 0 means the command ran, never a quality pass. 2 distinguishes fatal structure from warnings.
  if (result.chunks.some(c => c.status === 'fatal')) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) inspectionCli(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : '音声QAに失敗しました。'); process.exitCode = 1;
});
