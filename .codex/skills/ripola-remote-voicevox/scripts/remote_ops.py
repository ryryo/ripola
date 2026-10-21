"""Small remote operations. Executed over SSH or an authenticated exec API."""
import base64
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for data in iter(lambda: f.read(1024 * 1024), b''):
            h.update(data)
    return h.hexdigest()


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + '.writing')
    if path.is_symlink() or tmp.is_symlink():
        raise ValueError('Refuse a symlink target')
    with tmp.open('wb') as f:
        os.chmod(tmp, 0o600)
        f.write(data)
    tmp.replace(path)


def main(p):
    root = pathlib.Path(p['root'])
    if not root.is_absolute() or len(root.parts) < 3:
        raise ValueError('Use a dedicated absolute job root')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink():
        raise ValueError('Job root cannot be a symlink')

    def path(name):
        rel = pathlib.PurePosixPath(name)
        if rel.is_absolute() or '..' in rel.parts:
            raise ValueError('Unsafe relative path')
        target = root.joinpath(*rel.parts)
        if not target.resolve().is_relative_to(root.resolve()):
            raise ValueError('Path escapes job root')
        if target.is_symlink():
            raise ValueError('Symlinks are not supported')
        return target

    def read(name):
        try:
            return json.loads(path(name).read_text())
        except FileNotFoundError:
            return None

    def units():
        return ['ripola-' + p['jobId'] + suffix + '.service' for suffix in ('', '-engine')]

    op = p['op']
    if op == 'probe':
        version = subprocess.check_output(['git', '-C', p['repo'], 'rev-parse', 'HEAD'], text=True).strip()
        return {'sourceCommit': version, 'python': sys.version.split()[0],
                'node': shutil.which('node'), 'ffmpeg': shutil.which('ffmpeg'),
                'ffprobe': shutil.which('ffprobe'), 'flock': shutil.which('flock'),
                'systemctl': shutil.which('systemctl'), 'freeBytes': shutil.disk_usage(root).free}
    if op == 'upload':
        target = path(p['path'])
        data = base64.b64decode(p['data'], validate=True)
        if target.exists():
            if sha(target) != p['sha256']:
                raise ValueError('Existing staged file differs: ' + p['path'])
            return {'bytes': len(data), 'existing': True}
        temporary = target.with_name(target.name + '.upload')
        if temporary.is_symlink():
            raise ValueError('Refuse a symlink upload')
        temporary.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        offset = p['offset']
        if offset == 0:
            atomic(temporary, b'')
        if not temporary.exists() or temporary.stat().st_size != offset:
            raise ValueError('Upload offset differs')
        with temporary.open('ab') as f:
            f.write(data)
        if p['last']:
            if sha(temporary) != p['sha256']:
                raise ValueError('Staged file hash mismatch')
            temporary.replace(target)
        return {'bytes': len(data), 'existing': False}
    if op == 'status':
        services = {}
        for name in units():
            r = subprocess.run(['systemctl', 'show', name, '--property=ActiveState,SubState,MainPID,NRestarts,Result,UnitFileState'], capture_output=True, text=True)
            services[name] = dict(line.split('=', 1) for line in r.stdout.splitlines() if '=' in line)
        try:
            with path('batch.log').open('rb') as f:
                f.seek(max(0, f.seek(0, 2) - 8192))
                tail = f.read().decode('utf8', errors='replace').splitlines()[-8:]
        except FileNotFoundError:
            tail = []
        return {'progress': read('progress.json'), 'completion': read('completion.json'),
                'services': services, 'freeBytes': shutil.disk_usage(root).free, 'logTail': tail}
    if op == 'install':
        # Unit files and paths are arguments/data, never interpolated shell code.
        config = read('runtime.json')
        if not config or config['jobId'] != p['jobId']:
            raise ValueError('Stage the matching job first')
        import re
        for value in (str(root), p['repo'], p['engineRun'], p['node'], p['user']):
            if not re.fullmatch(r'[a-zA-Z0-9_./@-]+', value):
                raise ValueError('systemd execution paths/user must be simple absolute paths without spaces')
        engine, batch = units()[1], units()[0]
        engine_text = f'''[Unit]
Description=Ripola dedicated VOICEVOX engine {p['jobId']}
StartLimitIntervalSec=600
StartLimitBurst=3
[Service]
User={p['user']}
WorkingDirectory={pathlib.Path(p['engineRun']).parent}
ExecStart={p['engineRun']} --host 127.0.0.1 --port {p['port']} --cpu_num_threads {p['threads']} --disable_mutable_api
Restart=on-failure
RestartSec=10
UMask=0077
StandardOutput=append:{root}/engine.log
StandardError=append:{root}/engine.log
[Install]
WantedBy=multi-user.target
'''
        batch_text = f'''[Unit]
Description=Ripola remote job {p['jobId']}
Wants={engine}
After={engine}
StartLimitIntervalSec=1800
StartLimitBurst=3
[Service]
User={p['user']}
WorkingDirectory={p['repo']}
ExecStart={shutil.which('flock')} -n {root}/batch.lock {p['node']} --import tsx {root}/runtime/runner.mts {root}/runtime.json run
Restart=on-failure
RestartSec=30
KillMode=control-group
TimeoutStopSec=30
UMask=0077
StandardOutput=append:{root}/batch.log
StandardError=append:{root}/batch.log
[Install]
WantedBy=multi-user.target
'''
        for name, text in ((engine, engine_text), (batch, batch_text)):
            target = pathlib.Path('/etc/systemd/system') / name
            if target.exists():
                if target.read_text() != text:
                    raise ValueError('Existing unit differs; stop and review it: ' + name)
            else:
                subprocess.run(['sudo', '-n', 'tee', str(target)], input=text, text=True, stdout=subprocess.DEVNULL, check=True)
        subprocess.run(['sudo', '-n', 'systemd-analyze', 'verify', *[str(pathlib.Path('/etc/systemd/system') / n) for n in units()]], check=True, capture_output=True)
        subprocess.run(['sudo', '-n', 'systemctl', 'daemon-reload'], check=True)
        return {'installed': units(), 'started': False}
    if op in ('start', 'resume', 'stop'):
        config = read('runtime.json')
        if not config or config['jobId'] != p['jobId'] or config['root'] != str(root):
            raise ValueError('No matching staged runtime')
        if op != 'stop' and read('completion.json'):
            raise ValueError('Job already has a completion record; collect/review it, do not restart')
        if op != 'stop' and shutil.disk_usage(root).free < p['minFreeBytes']:
            raise ValueError('Insufficient free space; preserve outputs and stop')
        for index, name in enumerate(units()):
            target = pathlib.Path('/etc/systemd/system') / name
            if not target.exists() or f'StandardOutput=append:{root}/' not in target.read_text():
                raise ValueError('Unit is not owned by this job: ' + name)
        if op != 'stop':
            import socket
            active = subprocess.run(['systemctl', 'is-active', units()[1]], capture_output=True, text=True).stdout.strip() == 'active'
            try:
                with socket.create_connection(('127.0.0.1', 50021), timeout=1):
                    if not active:
                        raise ValueError('Engine port is in use by another service; do not replace it')
            except (ConnectionRefusedError, TimeoutError):
                pass
        command = ['sudo', '-n', 'systemctl']
        if op == 'stop':
            subprocess.run(command + ['disable', '--now', *units()], check=True, capture_output=True)
        else:
            # Never reset StartLimit automatically: repeated failure requires investigation.
            subprocess.run(command + ['enable', '--now', units()[1]], check=True, capture_output=True)
            subprocess.run(command + ['enable', '--now', units()[0]], check=True, capture_output=True)
        return {'operation': op, 'services': units()}
    if op == 'export':
        done = read('completion.json')
        if not done or done['inputHash'] != p['inputHash'] or done['phase'] != 'ready-for-import':
            raise ValueError('Completion is not ready-for-import for this input')
        archive = path('export.tar.gz')
        # A completed export is immutable; a failed export is built again under a temp name.
        if not archive.exists():
            temporary = path('export.tar.gz.building')
            with tarfile.open(temporary, 'w:gz', dereference=False) as tar:
                for name in ('library', 'completion.json', 'plans.json', 'input.json', 'progress.json', 'results'):
                    target = path(name)
                    for child in ([target] + list(target.rglob('*')) if target.is_dir() else [target]):
                        if child.is_symlink() or not (child.is_file() or child.is_dir()):
                            raise ValueError('Unexpected export member')
                    tar.add(target, arcname=name)
            os.chmod(temporary, 0o600)
            temporary.replace(archive)
        block = p['blockBytes']; rows = []; full = hashlib.sha256()
        with archive.open('rb') as f:
            while data := f.read(block):
                rows.append({'index': len(rows), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
                full.update(data)
        return {'schemaVersion': 1, 'inputHash': done['inputHash'], 'bytes': archive.stat().st_size,
                'sha256': full.hexdigest(), 'blockBytes': block, 'chunks': rows,
                'books': done['books'], 'totalChunks': done['chunks']}
    if op == 'range':
        if p['offset'] < 0 or p['bytes'] <= 0:
            raise ValueError('Invalid range')
        with path('export.tar.gz').open('rb') as f:
            f.seek(p['offset']); data = f.read(p['bytes'])
        if len(data) != p['bytes']:
            raise ValueError('Incomplete range')
        return {'data': base64.b64encode(data).decode()} if p['base64'] else data
    raise ValueError('Unknown remote operation')


if __name__ == '__main__':
    result = main(json.loads(base64.b64decode(sys.argv[1])))
    if isinstance(result, bytes):
        sys.stdout.buffer.write(result)
    else:
        print(json.dumps(result, ensure_ascii=False))
