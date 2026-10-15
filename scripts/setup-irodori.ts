import { join, resolve } from 'node:path';
import { findRepositoryRoot } from '../apps/web/src/generation/core/config.ts';
import { IrodoriModelStore } from '../apps/web/src/generation/core/irodori-model.ts';
import { IrodoriController } from '../apps/web/src/generation/core/irodori-controller.ts';

async function main(): Promise<void> {
  const [command = 'status', ...args] = process.argv.slice(2);
  const store = new IrodoriModelStore(join(await findRepositoryRoot(), '.reader-data', 'irodori'));
  if (command === 'status') { console.log(JSON.stringify(await new IrodoriController(store, process.env.RSVP_IRODORI_EXECUTABLE).status(), null, 2)); return; }
  if (command === 'cancel') { await store.cancel(); return; }
  if (command === 'install') {
    console.log('Irodori v4.1 Small通常版を明示導入します：約1.91GB。新規導入は約2.2GBの空き容量が必要です。取消し: Ctrl+C、再開: 同じinstallコマンド。');
    const controller = new AbortController(); const abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try { await store.install(controller.signal, state => console.log(`${state.phase}: ${(state.downloadedBytes / store.spec.bytes * 100).toFixed(1)}% · ${state.message}`)); }
    finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
    return;
  }
  if (command === 'register-voice') {
    const get = (name: string) => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? '';
    if (!args.includes('--confirm-voice-rights')) throw new Error('参照話者の明示同意と利用・配布条件を確認してから --confirm-voice-rights を指定してください。');
    await store.registerVoice({ path: resolve(get('file')), label: get('label'), source: get('source'), license: get('license'), attribution: get('attribution'), rightsConfirmed: true });
    console.log('既存の権利確認済みvoiceを登録しました。話者の学習・voice作成は実行していません。'); return;
  }
  throw new Error('Usage: pnpm exec tsx scripts/setup-irodori.ts status|install|cancel|register-voice --file=/absolute/voice.gguf --label=NAME --source=SOURCE --license=TERMS --attribution=CREDIT --confirm-voice-rights');
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Irodoriセットアップが失敗しました。'); process.exitCode = 1; });
