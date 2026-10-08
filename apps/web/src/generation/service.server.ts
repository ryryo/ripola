import '@tanstack/react-start/server-only';
import { getRequest } from '@tanstack/react-start/server';
import { assertLocalRequest } from '../server/local-request';
import { loadGenerationConfig } from './core/config';
import { GenerationService } from './core/service';

// Route reloads share one process-lifetime runner. The filesystem locks also protect CLI processes.
const runnerKey = Symbol.for('rsvp-reader.local-generation-service.v12');
const runners = globalThis as typeof globalThis & { [runnerKey]?: Promise<GenerationService> };
export function getGenerationService(): Promise<GenerationService> {
  return runners[runnerKey] ??= loadGenerationConfig().then(async (config) => {
    const service = new GenerationService(config); await service.ready(); return service;
  });
}
export async function getLocalGenerationService(): Promise<GenerationService> {
  const service = await getGenerationService();
  assertLocalRequest(getRequest(), service.config.localOrigin);
  return service;
}
