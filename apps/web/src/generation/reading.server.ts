import '@tanstack/react-start/server-only';
import { getRequest } from '@tanstack/react-start/server';
import { assertLocalRequest } from '../server/local-request';
import { loadLibraryConfig } from './core/config';
import { LibraryDisk } from './core/disk';
import { ReadingLibrary } from './core/reading-library';

let library: Promise<{ reader: ReadingLibrary; localOrigin: string }> | undefined;
export async function getLocalReadingLibrary() {
  const value = await (library ??= loadLibraryConfig().then(config => ({ reader: new ReadingLibrary(new LibraryDisk(config.libraryDir)), localOrigin: config.localOrigin })));
  assertLocalRequest(getRequest(), value.localOrigin);
  return value.reader;
}
