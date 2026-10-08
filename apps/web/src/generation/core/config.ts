import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

export interface RestGatewayConfig { mode?: 'rest'; accountId: string; gatewayId: string; token: string }
export interface WranglerGatewayConfig { mode: 'wrangler'; configPath: string; gatewayId: string; accountId?: string }
export type GeminiGatewayConfig = RestGatewayConfig | WranglerGatewayConfig;

export interface GenerationServerConfig {
  libraryDir: string;
  localOrigin: string;
  geminiApiKey?: string;
  gateway?: GeminiGatewayConfig;
  paidEnabled: boolean;
  alignmentPython?: string;
  alignmentModelDir?: string;
  alignmentScript?: string;
  alignmentCheckScript?: string;
  alignmentSetupState?: 'ready' | 'failed';
  alignmentVersion?: string;
  automaticCompression?: boolean;
}

export async function findRepositoryRoot(start = process.cwd()): Promise<string> {
  let candidate = resolve(start);
  for (;;) {
    try {
      const packageJson = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')) as { name?: string };
      if (packageJson.name === 'ripola') return candidate;
    } catch { /* Continue up to the repository root. */ }
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error('Ripolaのリポジトリから起動してください。');
    candidate = parent;
  }
}

/** Values remain in Node; browser configuration is a separate, redacted DTO. */
export async function loadGenerationConfig(repositoryRoot?: string): Promise<GenerationServerConfig> {
  const root = repositoryRoot ?? await findRepositoryRoot();
  let fileEnv: Record<string, string> = {};
  try {
    const contents = await readFile(join(root, '.env.local'), 'utf8');
    if (contents.length > 64 * 1024) throw new Error('設定ファイルが大きすぎます。');
    fileEnv = Object.fromEntries(Object.entries(parseEnv(contents)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // A parse error can contain secret file contents; do not return its cause over RPC.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('.env.localの読込に失敗しました。');
    }
  }
  let generated: { alignmentPython?: string; alignmentModelDir?: string; alignmentVersion?: string } = {};
  let alignmentSetupState: 'ready' | 'failed' | undefined;
  try {
    const value = JSON.parse(await readFile(join(root, 'alignment-runtime', 'setup.json'), 'utf8'));
    if (value.schemaVersion !== 1 || typeof value.alignmentPython !== 'string' || !isAbsolute(value.alignmentPython)
      || typeof value.alignmentModelDir !== 'string' || !isAbsolute(value.alignmentModelDir) || typeof value.alignmentVersion !== 'string') throw new Error();
    generated = value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') alignmentSetupState = 'failed'; }
  try {
    const state = JSON.parse(await readFile(join(root, 'alignment-runtime', 'setup-state.json'), 'utf8'));
    if (alignmentSetupState !== 'failed' && state.schemaVersion === 1 && (state.status === 'ready' || state.status === 'failed')) alignmentSetupState = state.status;
  } catch { /* Optional setup status never exposes paths or secrets. */ }
  const env = { ...fileEnv, ...process.env };
  const localOrigin = env.RSVP_LOCAL_ORIGIN ?? 'http://127.0.0.1:4173';
  let url: URL;
  try { url = new URL(localOrigin); } catch { throw new Error('ローカルURL設定が正しくありません。'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ローカルURLはlocalhostのHTTP originに限定してください。');
  }
  const alignmentPython = env.RSVP_ALIGNMENT_PYTHON || generated.alignmentPython;
  const alignmentModelDir = env.RSVP_ALIGNMENT_MODEL_DIR || generated.alignmentModelDir;
  if ((alignmentPython && !isAbsolute(alignmentPython)) || (alignmentModelDir && !isAbsolute(alignmentModelDir))) throw new Error('alignment runtimeとモデルの設定には絶対pathを指定してください。');
  const alignmentVersion = env.RSVP_ALIGNMENT_VERSION ?? generated.alignmentVersion ?? 'reazon-rs35kh-46afc596-ctc-v2';
  if (!/^[a-zA-Z0-9_.:@+-]{1,200}$/.test(alignmentVersion)) throw new Error('aligner version設定が正しくありません。');
  const accountId = env.RSVP_AI_GATEWAY_ACCOUNT_ID || undefined;
  const gatewayId = env.RSVP_AI_GATEWAY_ID || undefined;
  const token = env.RSVP_AI_GATEWAY_TOKEN || undefined;
  if ((accountId && !/^[a-f0-9]{32}$/.test(accountId))
    || (gatewayId && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(gatewayId))
    || (token && (!/^[\x21-\x7e]{1,4096}$/.test(token)))) throw new Error('Gateway設定の形式が正しくありません。account ID・Gateway ID・tokenを確認してください。');
  const configPath = join(root, 'deployment', 'local-ai.wrangler.jsonc');
  let project: { vars?: { RSVP_AI_GATEWAY_ID?: unknown }; account_id?: unknown } = {};
  try {
    // Read config only, using the same JSONC semantics as the pinned Wrangler API.
    // This does not start a dev session, authenticate, or retrieve OAuth credentials.
    await readFile(configPath, 'utf8');
    const { unstable_readConfig } = await import('wrangler');
    project = unstable_readConfig({ config: configPath });
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Never expose a config file or parser cause through RPC.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('ローカルAIのWrangler設定を読めません。');
    }
  }
  const projectGateway = project.vars?.RSVP_AI_GATEWAY_ID;
  const selectedGateway = gatewayId ?? (typeof projectGateway === 'string' ? projectGateway : '');
  if (selectedGateway && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(selectedGateway)) throw new Error('Wrangler設定のGateway IDが正しくありません。');
  if (project.account_id !== undefined && (typeof project.account_id !== 'string' || !/^[a-f0-9]{32}$/.test(project.account_id))) throw new Error('Wrangler設定のaccount IDが正しくありません。');
  if (env.RSVP_AI_GATEWAY_TRANSPORT && !['wrangler', 'rest'].includes(env.RSVP_AI_GATEWAY_TRANSPORT)) throw new Error('Cloudflare transportはwranglerまたはrestを指定してください。');
  const gateway: GeminiGatewayConfig | undefined = env.RSVP_AI_GATEWAY_TRANSPORT === 'rest'
    ? accountId && gatewayId && token ? { mode: 'rest', accountId, gatewayId, token } : undefined
    : { mode: 'wrangler', configPath, gatewayId: selectedGateway, ...(project.account_id ? { accountId: project.account_id as string } : {}) };
  return {
    ...(gateway ? { gateway } : {}),
    ...(alignmentPython ? { alignmentPython } : {}),
    ...(alignmentModelDir ? { alignmentModelDir } : {}),
    alignmentScript: join(root, 'scripts', 'align_audio.py'),
    alignmentCheckScript: join(root, 'scripts', 'check-alignment-runtime.py'),
    ...(alignmentSetupState ? { alignmentSetupState } : {}),
    alignmentVersion,
    libraryDir: resolve(env.RSVP_LIBRARY_DIR ?? join(homedir(), 'Documents', 'rsvp-reader-library')),
    localOrigin: url.origin,
    geminiApiKey: env.GEMINI_API_KEY || undefined,
    // 本文・接続先・概算の確認は各開始/再開時に必須。旧false指定は停止設定として尊重する。
    paidEnabled: env.RSVP_ENABLE_PAID_GENERATION === undefined || env.RSVP_ENABLE_PAID_GENERATION === 'true',
  };
}
