import type { GenerationOptions } from '../contracts';
import { IRODORI_LIMITS } from '../irodori-contracts';
import type { IrodoriController } from './irodori-controller';
import { irodoriFingerprint, irodoriSettings, synthesizeIrodori, type NativeSession } from './irodori-runtime';
import { SpeechRequestError, type SpeechAdapter } from './providers';

/** The optional injection seam also lets tests use a real loopback mock endpoint. */
export function irodoriAdapter(controller: IrodoriController, session: () => NativeSession = () => controller.runtime.current()): SpeechAdapter {
  const fingerprint = async (options?: GenerationOptions) => {
    if (!await controller.store.installed()) throw new SpeechRequestError('Irodoriは未導入です。任意追加の設定から導入してください。');
    const voice = await controller.store.voice();
    if (!voice) throw new SpeechRequestError('固定voiceが未登録です。権利確認済みの既存資材を登録してください。');
    const native = session();
    if (native.modelHash !== controller.store.spec.sha256 || native.voiceHash !== voice.sha256) throw new SpeechRequestError('Irodoriのモデル・固定voiceが起動時から変わっています。runtimeを起動し直してください。');
    return irodoriFingerprint(native, irodoriSettings(options?.irodori));
  };
  return {
    get endpoint() { try { return session().endpoint; } catch { return 'http://127.0.0.1 (Irodori停止中)'; } },
    capabilities: { local: true, supportsStyle: true, cancellation: 'abort', maxCharacters: IRODORI_LIMITS.recommendedMaxCharacters, ...IRODORI_LIMITS },
    availability: () => ({ available: controller.runtime.status === 'running', message: controller.runtime.status === 'running' ? undefined : 'Irodoriは任意追加です。モデル・固定voiceを用意し、設定からこのPCで起動してください。' }),
    async voices() { const status = await controller.status(); return status.voiceAvailable ? [{ id: 'ripola', name: status.voiceLabel ?? '固定voice' }] : []; },
    async attribution() { const voice = await controller.store.voice(); return voice?.attribution; },
    fingerprint,
    async preflight(options) {
      if (options.provider !== 'irodori' || options.transport !== 'direct' || options.voice !== 'ripola' || options.style || options.model && options.model !== 'irodori-tts-mf') throw new SpeechRequestError('Irodori MFはこのPCの固定voiceを選んでください。読み上げ指示はIrodori設定を使います。');
      await fingerprint(options);
    },
    async synthesize(request, beforeSend) {
      const current = await fingerprint(request.options);
      if (!request.providerVersion || request.providerVersion !== current) throw new SpeechRequestError('Irodoriのモデル・voice・合成設定が計画から変わっています。計画を更新してください。');
      await beforeSend(); request.signal?.throwIfAborted();
      try { return await synthesizeIrodori(session(), request.text, irodoriSettings(request.options.irodori), request.signal); }
      catch (error) {
        if (request.signal?.aborted) throw error;
        throw new SpeechRequestError(error instanceof Error ? error.message : 'Irodori合成を完了できません。');
      }
    },
  };
}
