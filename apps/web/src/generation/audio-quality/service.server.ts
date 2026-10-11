import '@tanstack/react-start/server-only';
import { getRequest } from '@tanstack/react-start/server';
import { assertLocalRequest } from '../../server/local-request';
import { loadGenerationConfig } from '../core/config';
import { LibraryDisk } from '../core/disk';
import { AudioInspectionService } from './service';
import { localReazonAsr } from './runtime';

/** Do not construct GenerationService: QA must not resume synthesis/compression jobs. */
export async function getLocalAudioInspector(): Promise<AudioInspectionService> {
  const config = await loadGenerationConfig();
  assertLocalRequest(getRequest(), config.localOrigin);
  return new AudioInspectionService(new LibraryDisk(config.libraryDir), localReazonAsr(config));
}
