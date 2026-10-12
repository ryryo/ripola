import { createServerFn } from '@tanstack/react-start';
import type { InspectSavedAudioInput } from './contracts';
import { getLocalAudioInspector } from './service.server';

export const inspectSavedAudio = createServerFn({ method: 'POST' }).validator((data: InspectSavedAudioInput) => data).handler(async ({ data }) => (await getLocalAudioInspector()).inspect(data));
export const getSavedAudioInspections = createServerFn({ method: 'GET' }).validator((data: { bookId: string; revision: string }) => data).handler(async ({ data }) => (await getLocalAudioInspector()).read(data.bookId, data.revision));
