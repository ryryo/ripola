import '@tanstack/react-start/server-only';
import { getRequest } from '@tanstack/react-start/server';
import { assertLocalRequest } from '../server/local-request';
import { loadGenerationConfig } from '../generation/core/config';
import { AozoraImporter } from './aozora.server';
import { NoteImporter } from './note.server';
import { supportedUrlInput } from './urls';

const key = Symbol.for('ripola.local-url-importers.v1');
const holders = globalThis as typeof globalThis & { [key]?: Promise<{ aozora: AozoraImporter; note: NoteImporter; localOrigin: string }> };
export async function importSingleUrl(url: string) {
  const { aozora, note, localOrigin } = await (holders[key] ??= loadGenerationConfig().then(config => ({
    aozora: new AozoraImporter(config.libraryDir), note: new NoteImporter(config.libraryDir), localOrigin: config.localOrigin,
  })));
  assertLocalRequest(getRequest(), localOrigin);
  const source = supportedUrlInput(url);
  if (source?.kind === 'aozora') return aozora.import(source.url);
  if (source?.kind === 'note') return note.import(source.url);
  throw new Error('このURLは取り込みに対応していません。');
}
