import type { GenerationOptions } from '../contracts';
import { IRODORI_LIMITS, IRODORI_MODEL, IRODORI_VOICES, irodoriVoice } from '../irodori-contracts';
import type { IrodoriController } from './irodori-controller';
import { IRODORI_CAPTION_VOICE_HASH, irodoriFingerprint, irodoriSettings, synthesizeIrodori, validateIrodoriText, type NativeSession } from './irodori-runtime';
import { SpeechRequestError, type SpeechAdapter } from './providers';

/** The optional injection seam also lets tests use a real loopback mock endpoint. */
export function irodoriAdapter(controller: IrodoriController, session: () => NativeSession = () => controller.runtime.current()): SpeechAdapter {
  function selectedSession(voice: string): NativeSession {
    const native = session();
    if (irodoriVoice(voice)) return { ...native, voice: 'none', voiceHash: IRODORI_CAPTION_VOICE_HASH };
    return native;
  }
  const fingerprint = async (options?: GenerationOptions) => {
    if (controller.store.spec.id === IRODORI_MODEL.id && options?.model && options.model !== IRODORI_MODEL.id) throw new SpeechRequestError('計画と導入済みモデルが異なります。生成計画を更新してください。');
    if (!await controller.store.installed()) throw new SpeechRequestError('Irodoriは未導入です。任意追加の設定から導入してください。');
    const selectedVoice = options?.voice ?? (controller.store.spec.id === IRODORI_MODEL.id ? 'reception-female' : 'ripola');
    const preset = irodoriVoice(selectedVoice);
    if (controller.store.spec.id === IRODORI_MODEL.id && !preset) throw new SpeechRequestError('通常版では受付の男女声を選んでください。');
    const voice = preset ? undefined : await controller.store.voice();
    if (!preset && !voice) throw new SpeechRequestError('固定voiceが未登録です。権利確認済みの既存資材を登録してください。');
    const native = selectedSession(selectedVoice);
    if (native.modelHash !== controller.store.spec.sha256 || !preset && native.voiceHash !== voice?.sha256) throw new SpeechRequestError('Irodoriのモデル・声が起動時から変わっています。runtimeを起動し直してください。');
    return irodoriFingerprint(native, irodoriSettings(options?.irodori, selectedVoice));
  };
  return {
    get endpoint() { try { return session().endpoint; } catch { return 'http://127.0.0.1 (Irodori停止中)'; } },
    capabilities: { local: true, supportsStyle: true, cancellation: 'abort', ...IRODORI_LIMITS },
    availability: () => ({ available: controller.runtime.status === 'running', message: controller.runtime.status === 'running' ? undefined : 'Irodoriは任意追加です。通常版モデルを導入し、設定からこのPCで起動してください。' }),
    async voices() { if (controller.store.spec.id === IRODORI_MODEL.id) return IRODORI_VOICES.map(({ id, name }) => ({ id, name })); const voice = await controller.store.voice(); return voice ? [{ id: 'ripola', name: voice.label }] : []; },
    async attribution(options) { if (irodoriVoice(options?.voice ?? '')) return '音声：Irodori-TTS v4.1 Small · 合成音声'; const voice = await controller.store.voice(); return voice?.attribution; },
    fingerprint,
    async preflight(options) {
      const preset = irodoriVoice(options.voice);
      if (options.provider !== 'irodori' || options.transport !== 'direct' || !preset && options.voice !== 'ripola' || options.style || options.model && !['irodori-tts', 'irodori-tts-mf'].includes(options.model)) throw new SpeechRequestError('対応するIrodoriの声を選んでください。読み上げ指示はIrodori設定を使います。');
      if (preset && controller.store.spec.id !== IRODORI_MODEL.id) throw new SpeechRequestError('受付の男女声はIrodori v4.1 Small通常版を導入・起動してください。');
      await fingerprint(options);
    },
    async synthesize(request, beforeSend) {
      const current = await fingerprint(request.options);
      if (!request.providerVersion || request.providerVersion !== current) throw new SpeechRequestError('Irodoriのモデル・voice・合成設定が計画から変わっています。計画を更新してください。');
      try { validateIrodoriText(request.text, irodoriSettings(request.options.irodori, request.options.voice)); }
      catch (error) { throw new SpeechRequestError(error instanceof Error ? error.message : 'Irodoriの本文上限を確認できません。'); }
      await beforeSend(); request.signal?.throwIfAborted();
      try { return await synthesizeIrodori(selectedSession(request.options.voice), request.text, irodoriSettings(request.options.irodori, request.options.voice), request.signal); }
      catch (error) {
        if (request.signal?.aborted) throw error;
        throw new SpeechRequestError(error instanceof Error ? error.message : 'Irodori合成を完了できません。');
      }
    },
  };
}
