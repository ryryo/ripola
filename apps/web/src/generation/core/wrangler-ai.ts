import type { WranglerGatewayConfig } from './config';

export const WRANGLER_GATEWAY_MISSING = 'Wranglerの既存ログインを利用します。既存Gatewayの選択が未完了です。local-ai.wrangler.jsoncのRSVP_AI_GATEWAY_IDを指定してください。手動tokenは不要です。';
export interface AiBinding {
  run(model: string, input: { text: string; voice: string }, options: { gateway: { id: string; collectLog: false; skipCache: true } }): Promise<unknown>;
}
export interface WranglerAiRuntime {
  connect(config: WranglerGatewayConfig): Promise<{ ai: AiBinding; dispose(): Promise<void> }>;
}

/** Wrangler owns OAuth loading/refresh. No credential files, tokens or login commands are read here. */
export const wranglerAiRuntime: WranglerAiRuntime = {
  async connect(config) {
    const { getPlatformProxy } = await import('wrangler');
    const platform = await getPlatformProxy({ configPath: config.configPath, remoteBindings: true, persist: false });
    const ai = platform.env.AI as AiBinding | undefined;
    if (!ai || typeof ai.run !== 'function') {
      await platform.dispose();
      throw new Error('Wranglerのremote AI bindingを確認できません。');
    }
    return { ai, dispose: () => platform.dispose() };
  },
};
