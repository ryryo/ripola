#!/usr/bin/env python3
"""Provider-neutral orchestration. Credentials stay in SSH or the provider CLI."""
import argparse
import base64
import concurrent.futures
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
import tarfile
import time
import uuid

SCRIPTS = pathlib.Path(__file__).resolve().parent


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(pathlib.Path(path).read_text())


def save(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x') as f:
        os.chmod(temporary, 0o600)
        json.dump(value, f, ensure_ascii=False, indent=2); f.write('\n')
    temporary.replace(path)


@contextlib.contextmanager
def lock(work, name):
    if work.is_symlink():
        raise ValueError('Work directory cannot be a symlink')
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (work / (name + '.lock')).open('a') as f:
        os.chmod(f.name, 0o600)
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another local operation owns ' + name) from None
        yield


def load_config(path):
    file = pathlib.Path(path).resolve(); c = read(file)
    if c.get('schemaVersion') != 1 or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,47}', c.get('jobId', '')):
        raise ValueError('schemaVersion=1 and a short lowercase jobId are required')
    for key in ('repo', 'workDir', 'inputFile', 'inputDir', 'localLibrary'):
        if key not in c:
            raise ValueError('Missing config field: ' + key)
        c[key] = str((file.parent / pathlib.Path(c[key]).expanduser()).resolve())
    for key in ('root', 'repo', 'engineRun', 'node'):
        value = c['remote'][key]
        if not value.startswith('/') or '..' in pathlib.PurePosixPath(value).parts or len(pathlib.PurePosixPath(value).parts) < 3:
            raise ValueError('Use dedicated absolute remote paths: ' + key)
    if not re.fullmatch(r'[0-9a-f]{40,64}', c.get('sourceCommit', '')):
        raise ValueError('Pin the sourceCommit used by the remote and local core')
    if not re.fullmatch(r'[a-zA-Z0-9_.-]{1,80}', c.get('engineVersion', '')):
        raise ValueError('Pin engineVersion')
    c.setdefault('minFreeBytes', 1024 ** 3)
    if not isinstance(c['minFreeBytes'], int) or c['minFreeBytes'] < 1:
        raise ValueError('minFreeBytes must be positive')
    if not isinstance(c['remote'].get('threads', 4), int) or not 1 <= c['remote'].get('threads', 4) <= 64:
        raise ValueError('Use 1 to 64 Engine threads')
    c['remote'].setdefault('enginePort', 50021)
    if c['remote']['enginePort'] != 50021:
        raise ValueError('Current core phoneme timing requires the loopback Engine on port 50021')
    c.setdefault('transport', {}).setdefault('mode', 'ssh')
    c.setdefault('transfer', {})
    for key, default in [('blockBytes', 8 * 1024 ** 2), ('apiRangeBytes', 256 * 1024), ('sshRangeBytes', 8 * 1024 ** 2), ('workers', 2), ('attempts', 3)]:
        c['transfer'].setdefault(key, default)
        if not isinstance(c['transfer'][key], int) or c['transfer'][key] < 1:
            raise ValueError('Invalid transfer setting: ' + key)
    if c['transfer']['workers'] > 8 or c['transfer']['attempts'] > 5 or c['transfer']['apiRangeBytes'] > 512 * 1024:
        raise ValueError('Use bounded concurrency/retries and API ranges up to 512 KiB')
    c['_file'] = str(file)
    return c


class Remote:
    def __init__(self, config, mode=None):
        self.c = config; self.mode = mode or config['transport']['mode']
        if self.mode == 'ssh':
            s = config['transport']['ssh']; host = s['host']
            if not re.fullmatch(r'[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*', host):
                raise ValueError('Invalid SSH host/alias')
            self.argv = ['ssh', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'BatchMode=yes']
            if s.get('configFile'):
                self.argv += ['-F', str((pathlib.Path(config['_file']).parent / pathlib.Path(s['configFile']).expanduser()).resolve())]
            if s.get('port'):
                self.argv += ['-p', str(int(s['port']))]
            self.argv += [host]
        elif self.mode == 'api':
            self.argv = config['transport']['api']['execArgv']
            if not self.argv or not all(isinstance(x, str) and x for x in self.argv):
                raise ValueError('API execArgv must be an argv prefix, not shell text')
        else:
            raise ValueError('Transport must be ssh or api')

    def machine_state(self):
        settings = self.c.get('machine')
        if not settings:
            return None
        argv = settings['statusArgv']
        if not argv or not all(isinstance(x, str) for x in argv):
            raise ValueError('machine.statusArgv must be an argv array')
        try:
            result = subprocess.run(argv, capture_output=True, timeout=60)
        except subprocess.TimeoutExpired:
            raise RuntimeError('Machine status timed out; no remote exec was sent') from None
        if result.returncode:
            raise RuntimeError('Machine status failed; no remote exec was sent')
        state = json.loads(result.stdout)
        if not isinstance(state, dict) or not isinstance(state.get('state'), str):
            raise ValueError('Machine status must return JSON with state and optional operationId')
        return state

    def require_running(self):
        state = self.machine_state()
        if state and (state['state'] not in self.c['machine'].get('runningStates', ['running']) or state.get('operationId')):
            raise RuntimeError('Machine is not ready; inspect/finish its operation before remote exec: ' + state['state'])

    def call(self, operation, **kwargs):
        payload = {'root': self.c['remote']['root'], 'repo': self.c['remote']['repo'], 'jobId': self.c['jobId'], **kwargs, 'op': operation}
        encoded = base64.b64encode(json.dumps(payload, ensure_ascii=False).encode()).decode()
        command = shlex.join(['python3', '-c', (SCRIPTS / 'remote_ops.py').read_text(), encoded])
        try:
            r = subprocess.run(self.argv + [command], capture_output=True, timeout=600 if operation == 'export' else 120)
        except subprocess.TimeoutExpired:
            raise RuntimeError('Remote ' + operation + ' timed out; inspect its state before retrying mutations') from None
        if r.returncode:
            # Never print an argv containing uploaded manuscript bytes.
            raise RuntimeError(f'Remote {operation} failed ({r.returncode}): ' + r.stderr.decode(errors='replace')[-2000:])
        if operation == 'range' and not kwargs['base64']:
            return r.stdout
        try:
            return json.loads(r.stdout)
        except (ValueError, UnicodeDecodeError):
            raise RuntimeError('Remote response is invalid/truncated; check the provider output limit') from None

    def upload(self, name, data):
        # Keep encoded upload arguments below Linux's per-argument limit.
        size = 48 * 1024
        for offset in range(0, max(1, len(data)), size):
            part = data[offset:offset + size]
            result = self.call('upload', path=name, data=base64.b64encode(part).decode(), offset=offset,
                               last=offset + size >= len(data), sha256=digest(data))
            if result.get('existing'):
                break


def local_commit(repo):
    return subprocess.check_output(['git', '-C', repo, 'rev-parse', 'HEAD'], text=True).strip()


def stage(c, remote):
    work = pathlib.Path(c['workDir'])
    with lock(work, 'stage'):
        if local_commit(c['repo']) != c['sourceCommit']:
            raise ValueError('Local checkout differs from pinned sourceCommit')
        probe = remote.call('probe')
        if probe['sourceCommit'] != c['sourceCommit']:
            raise ValueError('Remote checkout differs from pinned sourceCommit')
        if not all(probe[k] for k in ('node', 'ffmpeg', 'ffprobe', 'flock', 'systemctl')) or probe['freeBytes'] < c['minFreeBytes']:
            raise ValueError('Remote dependencies or free space are insufficient')
        original = read(c['inputFile'])
        if not isinstance(original.get('parts'), list) or not original['parts'] or not re.fullmatch(r'\d{1,8}', str(original.get('voice', ''))):
            raise ValueError('Input requires parts and a numeric VOICEVOX voice/style ID')
        if any(not isinstance(p.get('order'), int) or p['order'] < 1 or not isinstance(p.get('title'), str) for p in original['parts']) or len({p['order'] for p in original['parts']}) != len(original['parts']):
            raise ValueError('Part order must be unique')
        base = pathlib.Path(c['inputDir']); files = []
        for part in original['parts']:
            name = pathlib.PurePosixPath(part['file'])
            if name.is_absolute() or '..' in name.parts:
                raise ValueError('Unsafe manuscript path')
            source = base.joinpath(*name.parts)
            if source.is_symlink() or not source.resolve().is_relative_to(base.resolve()):
                raise ValueError('Manuscript must be inside inputDir')
            data = source.read_bytes()
            if digest(data) != part['sha256']:
                raise ValueError('Manuscript hash differs: ' + str(part['order']))
            files.append(('inputs/' + str(name), data))
        original['target'] = c['jobId']; original['sourceCommit'] = c['sourceCommit']
        data = (json.dumps(original, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
        identity = {'schemaVersion': 1, 'jobId': c['jobId'], 'inputHash': digest(data), 'sourceCommit': c['sourceCommit'],
                    'engineVersion': c['engineVersion'], 'parts': len(original['parts']), 'remoteRoot': c['remote']['root']}
        if (work / 'handoff.json').exists():
            old = read(work / 'handoff.json')
            if any(old.get(k) != v for k, v in identity.items()):
                raise ValueError('Job identity changed; use a new workDir and remote root')
        runtime = {**identity, 'repo': c['remote']['repo'], 'root': c['remote']['root'], 'minFreeBytes': c['minFreeBytes'],
                   'engineEndpoint': 'http://127.0.0.1:' + str(c['remote']['enginePort'])}
        # Runtime and input are immutable once staged; all live state is separate.
        for name, content in [('runtime.json', (json.dumps(runtime) + '\n').encode()), ('input.json', data), *files]:
            remote.upload(name, content)
        for script in ('runner.mts', 'voicevox-adapter.mts', 'core.mts'):
            remote.upload('runtime/' + script, (SCRIPTS / script).read_bytes())
        save(work / 'handoff.json', identity); save(work / 'probe.json', probe)
        return identity


def monitor(c, remote):
    work = pathlib.Path(c['workDir']); machine = remote.machine_state()
    if machine and (machine['state'] not in c['machine'].get('runningStates', ['running']) or machine.get('operationId')):
        # A read-only heartbeat must not wake a paused machine through exec.
        prior = read(work / 'monitor-state.json') if (work / 'monitor-state.json').exists() else {}
        state = {'machine': machine, 'machineInactive': True, 'checkedAt': now(),
                 'lastObservedProgress': prior.get('progress') or prior.get('lastObservedProgress'),
                 'progressObservedAt': prior.get('progressObservedAt') or prior.get('checkedAt')}
        save(work / 'monitor-state.json', state)
        return state
    state = remote.call('status')
    if machine:
        state['machine'] = machine
    state['checkedAt'] = now(); state['transport'] = remote.mode
    progress = state.get('progress') or {}; handoff = read(work / 'handoff.json')
    if progress and progress.get('inputHash') != handoff['inputHash']:
        raise ValueError('Remote progress belongs to another input')
    done = progress.get('completedChunks', 0); total = progress.get('totalChunks', 0)
    state['generationPercent'] = round(done / total * 100, 1) if total else None
    previous_file = work / 'last-notified.json'
    previous = read(previous_file) if previous_file.exists() else None
    state['deltaChunksSinceNotification'] = done - previous['completedChunks'] if previous and previous.get('inputHash') == handoff['inputHash'] else None
    last = progress.get('lastProgressAt')
    state['staleSeconds'] = max(0, (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(last.replace('Z', '+00:00'))).total_seconds()) if last else None
    state['needsInvestigation'] = bool(state['staleSeconds'] and state['staleSeconds'] > 900 and progress.get('phase') not in ('ready-for-import', 'review-required'))
    state['lowDisk'] = state['freeBytes'] < c['minFreeBytes']
    for filename, key in [('transfer-progress.json', 'transfer'), ('import-work/progress.json', 'import')]:
        if (work / filename).exists():
            state[key] = read(work / filename)
    save(work / 'monitor-state.json', state)
    return state


def extract_archive(archive, target):
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            name = pathlib.PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe archive member: ' + member.name)
        # Validated regular files/directories only; target is a new private directory.
        tar.extractall(target, filter='data')


def collect(c, remote):
    work = pathlib.Path(c['workDir']); handoff = read(work / 'handoff.json')
    with lock(work, 'collect'):
        if (work / 'collection.json').exists():
            report = read(work / 'collection.json')
            if report['inputHash'] != handoff['inputHash']:
                raise ValueError('Existing collection belongs to another input')
            return report
        transfer = c['transfer']
        m = remote.call('export', inputHash=handoff['inputHash'], blockBytes=transfer['blockBytes'])
        if m['inputHash'] != handoff['inputHash'] or m['books'] != handoff['parts']:
            raise ValueError('Export identity differs')
        expected = 0
        for index, row in enumerate(m['chunks']):
            if row['index'] != index or not 0 < row['bytes'] <= m['blockBytes'] or not re.fullmatch(r'[a-f0-9]{64}', row['sha256']):
                raise ValueError('Invalid export manifest')
            expected += row['bytes']
        if expected != m['bytes'] or not re.fullmatch(r'[a-f0-9]{64}', m['sha256']):
            raise ValueError('Invalid export size/hash')
        save(work / 'transfer-manifest.json', m)
        chunks = work / ('transfer-' + m['sha256'])
        if chunks.is_symlink():
            raise ValueError('Transfer directory cannot be a symlink')
        chunks.mkdir(mode=0o700, exist_ok=True)
        def valid(path, row):
            return path.is_file() and not path.is_symlink() and path.stat().st_size == row['bytes'] and digest(path.read_bytes()) == row['sha256']
        def progress():
            count = sum(row['bytes'] for row in m['chunks'] if valid(chunks / str(row['index']), row))
            state = {'phase': 'collecting', 'pid': os.getpid(), 'inputHash': m['inputHash'], 'transport': remote.mode,
                     'verifiedBytes': count, 'totalBytes': m['bytes'], 'percent': round(count / m['bytes'] * 100, 1), 'updatedAt': now()}
            save(work / 'transfer-progress.json', state)
        def fetch(row):
            path = chunks / str(row['index'])
            if valid(path, row):
                return
            temporary = chunks / (str(row['index']) + '.part')
            if temporary.is_symlink():
                raise ValueError('Partial file cannot be a symlink')
            # Resume within a block too; final SHA detects any corrupt partial file.
            offset = temporary.stat().st_size if temporary.exists() else 0
            if offset > row['bytes']:
                raise ValueError('Oversized partial block; inspect it before retrying')
            size = transfer['apiRangeBytes' if remote.mode == 'api' else 'sshRangeBytes']
            with temporary.open('ab') as output:
                os.chmod(temporary, 0o600)
                while offset < row['bytes']:
                    amount = min(size, row['bytes'] - offset)
                    for attempt in range(transfer['attempts']):
                        try:
                            data = remote.call('range', offset=row['index'] * m['blockBytes'] + offset, bytes=amount, base64=remote.mode == 'api')
                            if remote.mode == 'api':
                                data = base64.b64decode(data['data'], validate=True)
                            if len(data) != amount:
                                raise ValueError('Incomplete range')
                            break
                        except Exception:
                            if attempt + 1 == transfer['attempts']:
                                raise
                            time.sleep(2 ** attempt)
                    output.write(data); output.flush(); offset += amount
            if not valid(temporary, row):
                raise ValueError('Downloaded block hash differs; keep it for investigation')
            temporary.replace(path)
        progress()
        with concurrent.futures.ThreadPoolExecutor(max_workers=transfer['workers']) as pool:
            futures = [pool.submit(fetch, row) for row in m['chunks']]
            for future in concurrent.futures.as_completed(futures):
                future.result(); progress()
        archive = work / 'completed-library.tar.gz'; tmp = archive.with_suffix('.assembling'); h = hashlib.sha256()
        with tmp.open('wb') as output:
            os.chmod(tmp, 0o600)
            for row in m['chunks']:
                data = (chunks / str(row['index'])).read_bytes(); output.write(data); h.update(data)
        if tmp.stat().st_size != m['bytes'] or h.hexdigest() != m['sha256']:
            raise ValueError('Full archive hash differs')
        tmp.replace(archive)
        incoming = work / 'incoming'; extracting = work / 'incoming.extracting'
        if incoming.exists():
            raise ValueError('incoming exists without a collection receipt; inspect it before proceeding')
        if extracting.exists():
            # Prior interrupted extraction is isolated and reproducible from the verified archive.
            import shutil
            if extracting.is_symlink():
                raise ValueError('Extraction directory is a symlink')
            shutil.rmtree(extracting)
        extracting.mkdir(mode=0o700)
        extract_archive(archive, extracting)
        done = read(extracting / 'completion.json'); plans = read(extracting / 'plans.json')
        if done['phase'] != 'ready-for-import' or done['inputHash'] != handoff['inputHash'] or done['books'] != len(plans) or done['chunks'] != sum(p['chunks'] for p in plans) or done['chunks'] != m['totalChunks'] or done['warningCount']:
            raise ValueError('Recovered completion/QA/counts differ')
        extracting.rename(incoming)
        report = {'phase': 'collected', 'inputHash': m['inputHash'], 'archive': str(archive), 'bytes': m['bytes'], 'sha256': m['sha256'],
                  'books': done['books'], 'chunks': done['chunks'], 'transport': remote.mode, 'completedAt': now()}
        save(work / 'collection.json', report)
        save(work / 'transfer-progress.json', {**report, 'percent': 100.0})
        return report


def cli(default=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--transport', choices=['ssh', 'api'])
    parser.add_argument('action', nargs='?' if default else None, default=default,
                        choices=[default] if default else ['probe', 'stage', 'install', 'start', 'status', 'resume', 'stop', 'collect', 'notified'])
    args = parser.parse_args(); c = load_config(args.config); remote = Remote(c, args.transport)
    action = args.action
    if action not in ('status', 'notified'):
        remote.require_running()
    if action == 'stage':
        result = stage(c, remote)
    elif action == 'status':
        result = monitor(c, remote)
    elif action == 'collect':
        result = collect(c, remote)
    elif action == 'notified':
        state = read(pathlib.Path(c['workDir']) / 'monitor-state.json'); p = state.get('progress') or state.get('lastObservedProgress') or {}
        result = {'inputHash': read(pathlib.Path(c['workDir']) / 'handoff.json')['inputHash'], 'completedChunks': p.get('completedChunks', 0), 'reportedAt': now()}
        save(pathlib.Path(c['workDir']) / 'last-notified.json', result)
    else:
        result = remote.call(action, **({'minFreeBytes': c['minFreeBytes']} if action in ('start', 'resume') else {}),
                             **({'engineRun': c['remote']['engineRun'], 'node': c['remote']['node'], 'user': c['remote']['user'], 'threads': c['remote'].get('threads', 4), 'port': c['remote']['enginePort']} if action == 'install' else {}))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        cli()
    except Exception as error:
        print(str(error), file=sys.stderr); sys.exit(1)
