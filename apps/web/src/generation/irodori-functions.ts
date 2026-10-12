import { createServerFn } from '@tanstack/react-start';
import type { IrodoriSettings } from './irodori-contracts';
import { localIrodoriController } from './irodori.server';

export const getIrodoriStatus = createServerFn({ method: 'GET' }).handler(async () => (await localIrodoriController()).status());
export const installIrodori = createServerFn({ method: 'POST' }).handler(async () => { await (await localIrodoriController()).install(); });
export const cancelIrodoriInstall = createServerFn({ method: 'POST' }).handler(async () => { await (await localIrodoriController()).store.cancel(); });
export const startIrodoriRuntime = createServerFn({ method: 'POST' }).handler(async () => { await (await localIrodoriController()).runtime.start(); });
export const stopIrodoriRuntime = createServerFn({ method: 'POST' }).handler(async () => { await (await localIrodoriController()).runtime.stop(); });
export const getIrodoriSettings = createServerFn({ method: 'GET' }).validator((voice: string) => voice).handler(async ({ data }) => (await localIrodoriController()).settings(data));
export const saveIrodoriSettings = createServerFn({ method: 'POST' }).validator((data: { voice: string; settings: IrodoriSettings }) => data).handler(async ({ data }) => { await (await localIrodoriController()).saveSettings(data.settings, data.voice); });
