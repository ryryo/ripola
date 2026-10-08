/* global AbortController */
// 捕捉した原因に端末pathや秘密設定が含まれるため、利用者向けエラーへ添付しない。
/* eslint-disable preserve-caught-error */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm, access, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout, clearTimeout } from 'node:timers';

const digest = value => createHash('sha256').update(value).digest('hex');
const guidance = 'Python 3.13とffmpegが必要です。Homebrew導入済みなら brew install python@3.13 ffmpeg を自分で実行し、pnpm setup:audio を再実行してください。https://www.python.org/downloads/macos/ · https://ffmpeg.org/download.html';

export async function runCommand(binary, args, { cwd, env, onOutput = () => {}, signal, timeout = 20 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Error('セットアップを中断しました。')); return; }
    let stdout = '';
    const child = spawn(binary, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let killDeadline;
    const stop = () => { child.kill('SIGTERM'); killDeadline ??= setTimeout(() => child.kill('SIGKILL'), 1000); };
    const deadline = setTimeout(stop, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    const cleanup = () => { clearTimeout(deadline); clearTimeout(killDeadline); signal?.removeEventListener('abort', stop); };
    child.stdout.on('data', part => {
      stdout += part;
      if (stdout.length > 2 * 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
      onOutput(part.toString());
    });
    // 診断に認証情報や端末pathが混ざる可能性があるため、生のstderrを出力しない。
    child.stderr.on('data', () => {});
    child.once('error', () => { cleanup(); reject(Error('実行に必要なコマンドを起動できません。')); });
    child.once('close', code => {
      cleanup();
      if (code === 0 && !signal?.aborted) resolve(stdout);
      else reject(Error(signal?.aborted ? 'セットアップを中断しました。' : '実行したコマンドが正常に完了しませんでした。'));
    });
  });
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + process.pid + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}
export async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw Error('セットアップ設定を読めません。既存ファイルは保持しています。');
  }
}
async function acquireLock(lock) {
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readJson(join(lock, 'owner.json'));
    let alive = false;
    try { if (Number.isInteger(owner?.pid) && owner.pid > 0) { process.kill(owner.pid, 0); alive = true; } }
    catch (error) { if (error.code !== 'ESRCH') alive = true; }
    // owner書込直前の競合は待つ。異常終了で残ったownerなしlockは1分後から回復できる。
    if (alive || (!owner?.pid && Date.now() - (await stat(lock)).mtimeMs < 60_000)) throw Error('別のpnpm setup:audioが実行中です。完了後に再実行してください。');
    await rm(lock, { recursive: true });
    await mkdir(lock);
  }
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
}
export async function setupAlignment({
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), platform = process.platform,
  arch = process.arch, environment = process.env, run = runCommand, log = console.log, signal,
} = {}) {
  if (platform !== 'darwin' || arch !== 'arm64') throw Error('pnpm setup:audioの検証済み対象はmacOS Apple Siliconです。Windows/Linux/Intel Macの自動導入はまだ対応していません。');
  const runtime = join(root, 'alignment-runtime');
  const configuration = join(runtime, 'setup.json'), state = join(runtime, 'setup-state.json');
  const manifestBytes = await readFile(join(root, 'scripts/alignment-model.json'));
  const manifest = JSON.parse(manifestBytes);
  const requirements = await readFile(join(root, 'scripts/alignment-requirements.txt'));
  log(`音声補正を準備します。初回モデル約${(manifest.downloadBytes / 1e6).toFixed(1)} MB、Python依存約110 MB、導入後の専用環境＋モデルは約1 GBです。既存環境・検証済みcacheは再利用します。`);
  let fileEnv = {};
  try {
    const contents = await readFile(join(root, '.env.local'), 'utf8');
    if (contents.length > 64 * 1024) throw Error();
    fileEnv = parseEnv(contents);
  } catch (error) { if (error.code !== 'ENOENT') throw Error('.env.localを読めません。内容を変更せず停止しました。'); }
  const generated = await readJson(configuration);
  if (generated && (generated.schemaVersion !== 1 || typeof generated.alignmentPython !== 'string' || !isAbsolute(generated.alignmentPython) || typeof generated.alignmentModelDir !== 'string' || !isAbsolute(generated.alignmentModelDir))) throw Error('自動設定の形式が正しくありません。既存ファイルを保持して停止しました。');
  const env = { ...fileEnv, ...environment };
  if (env.RSVP_ALIGNMENT_VERSION && env.RSVP_ALIGNMENT_VERSION !== manifest.alignerVersion) throw Error('旧設定のモデルversionが固定versionと異なります。既存設定を変更せず停止しました。');
  const explicitPython = env.RSVP_ALIGNMENT_PYTHON || generated?.alignmentPython;
  const explicitModel = env.RSVP_ALIGNMENT_MODEL_DIR || generated?.alignmentModelDir;
  const managedPython = join(runtime, '.venv/bin/python');
  const managedModel = join(runtime, 'models/reazon-rs35kh-46afc596');
  const python = explicitPython || managedPython, model = explicitModel || managedModel;
  if (!isAbsolute(python) || !isAbsolute(model)) throw Error('既存のPython/model指定は絶対pathにしてください。既存設定は変更しません。');
  const childEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) if (environment[key]) childEnv[key] = environment[key];
  Object.assign(childEnv, { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false', PIP_CONFIG_FILE: '/dev/null', PYTHONDONTWRITEBYTECODE: '1' });
  const command = (binary, args, options = {}) => run(binary, args, { cwd: root, env: childEnv, signal, ...options });
  const lock = join(runtime, 'setup.lock');
  await mkdir(runtime, { recursive: true });
  await acquireLock(lock);
  let stage = 'prerequisites', dependenciesInstalled = false, modelDownloadInvoked = false;
  try {
    for (const binary of ['ffmpeg', 'ffprobe']) {
      try { await command(binary, ['-version'], { timeout: 15_000 }); }
      catch { throw Error(`${binary}が見つからないか利用できません。${guidance}`); }
    }
    let present = true;
    try { await access(python); } catch { present = false; }
    if (!present) {
      if (explicitPython && python !== managedPython) throw Error('既存指定のPythonを起動できません。設定を変更せず停止しました。指定pathを確認してください。');
      let version;
      try { version = JSON.parse(await command('python3.13', ['-c', 'import json,sys,platform;print(json.dumps({"version":list(sys.version_info[:2]),"machine":platform.machine()}))'], { timeout: 15_000 })); }
      catch { throw Error(guidance); }
      if (version.version?.join('.') !== '3.13' || version.machine !== 'arm64') throw Error(guidance);
      stage = 'venv'; log('専用Python環境を作成しています。');
      await command('python3.13', ['-m', 'venv', join(runtime, '.venv')]);
    }
    stage = 'dependencies';
    let packagesReady = false;
    try { await command(python, [join(root, 'scripts/check-alignment-runtime.py'), '--dependencies-only'], { timeout: 60_000 }); packagesReady = true; } catch { /* 未導入なら専用venvだけ修復する。 */ }
    if (!packagesReady) {
      if (explicitPython && python !== managedPython) throw Error('既存の解析Pythonの依存/versionが一致しません。既存環境を変更せず停止しました。専用環境の設定を確認してください。');
      log('固定されたPython依存を導入しています（PyPI公式wheel、hash検証）。');
      await command(python, ['-m', 'ensurepip', '--upgrade']);
      await command(python, ['-m', 'pip', '--isolated', 'install', '--index-url', 'https://pypi.org/simple', '--only-binary=:all:', '--require-hashes', '--disable-pip-version-check', '--cache-dir', join(runtime, 'pip-cache'), '-r', join(root, 'scripts/alignment-requirements.txt')], { onOutput: part => { if (/Successfully installed|Requirement already satisfied/.test(part)) log(part.trim()); } });
      dependenciesInstalled = true;
    } else log('固定Python依存を再利用します。');
    stage = 'model';
    let modelReady = false;
    try { await command(python, [join(root, 'scripts/check-alignment-runtime.py'), '--model-only', '--model-dir', model], { timeout: 60_000 }); modelReady = true; } catch { /* 管理モデルの不足ファイルのみ取得する。 */ }
    if (!modelReady) {
      if (explicitModel && model !== managedModel) throw Error('既存指定モデルの固定hashが一致しません。既存モデルを変更せず停止しました。');
      log('約386.9 MBの固定モデルを取得・検証しています。不足ファイルだけ取得します。');
      await command(python, [join(root, 'scripts/download_alignment_model.py'), '--model-dir', model], { onOutput: part => log(part.trim()) });
      modelDownloadInvoked = true;
    } else log('固定モデル7ファイルを検証し、再利用します。');
    stage = 'verification';
    await command(python, [join(root, 'scripts/check-alignment-runtime.py'), '--model-dir', model], { timeout: 60_000 });
    stage = 'configuration';
    const result = { schemaVersion: 1, alignmentPython: python, alignmentModelDir: model, alignmentVersion: manifest.alignerVersion, requirementsHash: digest(requirements), modelManifestHash: digest(manifestBytes), completedAt: new Date().toISOString() };
    await atomicJson(configuration, result);
    await atomicJson(state, { schemaVersion: 1, status: 'ready', updatedAt: result.completedAt });
    log('音声補正：利用可能。設定を自動保存しました（.env.localは変更していません）。pnpm devで起動してください。起動中なら再起動してください。');
    return { status: 'ready', dependenciesInstalled, modelDownloadInvoked, configuration };
  } catch (error) {
    await atomicJson(state, { schemaVersion: 1, status: 'failed', stage, updatedAt: new Date().toISOString() });
    throw Error(`${stage}の準備に失敗しました。${error.message} 保存済みファイルを再利用できるので、解決後pnpm setup:audioを再実行してください。`);
  } finally { await rm(lock, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 2) { console.error('Usage: pnpm setup:audio'); process.exitCode = 1; }
  else {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    await setupAlignment({ signal: controller.signal }).catch(error => { console.error(error.message); process.exitCode = 1; });
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
