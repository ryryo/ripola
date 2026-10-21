#!/usr/bin/env python3
"""Local protocol doubles: no external account, SSH daemon, or systemd mutation."""
import hashlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from remote import Remote, collect, digest, extract_archive, load_config, monitor, save, stage
import remote_ops


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ripola-remote-skill-')
        self.root = pathlib.Path(self.temp.name)
        self.bin = self.root / 'bin'; self.bin.mkdir()
        self.log = self.root / 'ranges.jsonl'
        shim = self.root / 'exec-shim.py'
        shim.write_text('''import base64,json,os,shlex,subprocess,sys
command=sys.argv[-1]
if sys.argv[1]!='api':
 assert 'StrictHostKeyChecking=yes' in sys.argv
 assert 'UpdateHostKeys=no' in sys.argv
payload=json.loads(base64.b64decode(shlex.split(command)[-1]))
if payload['op']=='range':
 with open(os.environ['RIPOLA_TEST_RANGES'],'a') as f:f.write(json.dumps({'offset':payload['offset'],'bytes':payload['bytes']})+'\\n')
r=subprocess.run(command,shell=True,capture_output=True)
sys.stdout.buffer.write(r.stdout[:int(os.environ.get('RIPOLA_TEST_OUTPUT_LIMIT','99999999'))])
sys.stderr.buffer.write(r.stderr);sys.exit(r.returncode)
''')
        ssh = self.bin / 'ssh'; ssh.write_text('#!' + sys.executable + '\n' + shim.read_text()); ssh.chmod(0o700)
        # Status reads an inert systemctl double, never the machine's service manager.
        systemctl = self.bin / 'systemctl'; systemctl.write_text('#!/bin/sh\nprintf "ActiveState=inactive\\nSubState=dead\\nMainPID=0\\nResult=success\\n"\n'); systemctl.chmod(0o700)
        self.env = patch.dict(os.environ, {'PATH': str(self.bin) + os.pathsep + os.environ['PATH'], 'RIPOLA_TEST_RANGES': str(self.log)})
        self.env.start()
        self.repo = pathlib.Path(__file__).resolve().parents[4]
        self.commit = subprocess.check_output(['git', '-C', str(self.repo), 'rev-parse', 'HEAD'], text=True).strip()
        self.file = self.root / 'job.json'
        config = {'schemaVersion': 1, 'jobId': 'fixture-job', 'repo': str(self.repo), 'workDir': 'work', 'inputFile': 'input.json', 'inputDir': 'inputs', 'localLibrary': 'shelf',
                  'sourceCommit': self.commit, 'engineVersion': '0.25.2', 'minFreeBytes': 1,
                  'remote': {'root': str(self.root / 'remote'), 'repo': str(self.repo), 'engineRun': '/fixture/engine/run', 'node': '/fixture/node', 'user': 'fixture'},
                  'transport': {'mode': 'ssh', 'ssh': {'host': 'fixture-host'}, 'api': {'execArgv': [sys.executable, str(shim), 'api']}},
                  'transfer': {'blockBytes': 16384, 'sshRangeBytes': 4096, 'apiRangeBytes': 3072, 'workers': 2, 'attempts': 2}}
        save(self.file, config); self.c = load_config(self.file)

    def tearDown(self):
        self.env.stop(); self.temp.cleanup()

    def fixture(self):
        root = pathlib.Path(self.c['remote']['root']); (root / 'library').mkdir(parents=True)
        (root / 'library/audio.bin').write_bytes(os.urandom(53001))
        for name, data in {'completion.json': {'phase': 'ready-for-import', 'inputHash': 'a' * 64, 'books': 1, 'chunks': 2, 'warningCount': 0},
                           'plans.json': [{'chunks': 2}], 'input.json': {}, 'progress.json': {}}.items():
            save(root / name, data)
        (root / 'results').mkdir()
        save(pathlib.Path(self.c['workDir']) / 'handoff.json', {'inputHash': 'a' * 64, 'parts': 1})
        return root

    def test_both_transports_resume_and_recollect_without_reads(self):
        root = self.fixture()
        for mode in ('ssh', 'api'):
            with self.subTest(mode=mode):
                c = {**self.c, 'workDir': str(self.root / ('work-' + mode))}
                save(pathlib.Path(c['workDir']) / 'handoff.json', {'inputHash': 'a' * 64, 'parts': 1})
                remote = Remote(c, mode)
                m = remote.call('export', inputHash='a' * 64, blockBytes=c['transfer']['blockBytes'])
                chunks = pathlib.Path(c['workDir']) / ('transfer-' + m['sha256']); chunks.mkdir()
                archive = (root / 'export.tar.gz').read_bytes()
                # First block complete; second block interrupted mid-range.
                (chunks / '0').write_bytes(archive[:m['blockBytes']])
                (chunks / '1.part').write_bytes(archive[m['blockBytes']:m['blockBytes'] + 997])
                self.log.write_text('')
                report = collect(c, remote)
                self.assertEqual(report['sha256'], digest(archive))
                self.assertEqual((pathlib.Path(c['workDir']) / 'incoming/library/audio.bin').read_bytes(), (root / 'library/audio.bin').read_bytes())
                requests = [json.loads(s) for s in self.log.read_text().splitlines()]
                self.assertTrue(requests)
                self.assertTrue(all(p['offset'] >= m['blockBytes'] + 997 for p in requests))
                before = self.log.read_bytes(); collect(c, Remote(c, 'api' if mode == 'ssh' else 'ssh'))
                self.assertEqual(before, self.log.read_bytes())

    def test_upload_is_hashed_and_never_overwrites(self):
        for mode in ('ssh', 'api'):
            r = Remote(self.c, mode); data = '自作の原稿\n'.encode() * 10000
            name = "inputs/quote ' and space-" + mode + '.md'
            r.upload(name, data); r.upload(name, data)
            target = pathlib.Path(self.c['remote']['root']) / name
            self.assertEqual(data, target.read_bytes())
            with self.assertRaisesRegex(RuntimeError, 'differs'):
                r.upload(name, b'different')
            self.assertEqual(data, target.read_bytes())

    def test_corrupt_partial_stops_before_extraction(self):
        self.fixture(); r = Remote(self.c, 'api')
        m = r.call('export', inputHash='a' * 64, blockBytes=self.c['transfer']['blockBytes'])
        chunks = pathlib.Path(self.c['workDir']) / ('transfer-' + m['sha256']); chunks.mkdir()
        (chunks / '0.part').write_bytes(b'wrong-prefix')
        with self.assertRaisesRegex(ValueError, 'hash differs'):
            collect(self.c, r)
        self.assertFalse((pathlib.Path(self.c['workDir']) / 'incoming').exists())

    def test_api_truncation_is_rejected_and_bounded(self):
        self.fixture()
        Remote(self.c, 'api').call('export', inputHash='a' * 64, blockBytes=self.c['transfer']['blockBytes'])
        with patch.dict(os.environ, {'RIPOLA_TEST_OUTPUT_LIMIT': '80'}):
            with self.assertRaisesRegex(RuntimeError, 'invalid/truncated'):
                Remote(self.c, 'api').call('range', offset=0, bytes=4096, base64=True)

    def test_unsafe_archives_are_rejected(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE), ('link', tarfile.SYMTYPE), ('hard', tarfile.LNKTYPE), ('fifo', tarfile.FIFOTYPE)]:
            with self.subTest(name=name):
                p = self.root / 'unsafe.tar'; item = tarfile.TarInfo(name); item.type = kind
                with tarfile.open(p, 'w') as tar: tar.addfile(item)
                dest = self.root / 'extract'; dest.mkdir(exist_ok=True)
                with self.assertRaisesRegex(ValueError, 'Unsafe archive'):
                    extract_archive(p, dest)
                self.assertFalse(list(dest.iterdir()))

    def test_stage_and_monitor_keep_job_identity(self):
        (self.root / 'inputs').mkdir(); text = 'これは自作の検証原稿です。'.encode()
        (self.root / 'inputs/part.md').write_bytes(text)
        save(self.root / 'input.json', {'voice': '7', 'parts': [{'order': 1, 'title': '自作', 'file': 'part.md', 'sha256': digest(text)}]})
        r = Remote(self.c, 'api'); actual = r.call
        def call(op, **kwargs):
            if op == 'probe': return {'sourceCommit': self.commit, 'node': 'node', 'ffmpeg': 'ffmpeg', 'ffprobe': 'ffprobe', 'flock': 'flock', 'systemctl': 'systemctl', 'freeBytes': 2**30}
            return actual(op, **kwargs)
        with patch.object(r, 'call', side_effect=call):
            handoff = stage(self.c, r); self.assertEqual(handoff, stage(self.c, r))
            changed = '変えた原稿です。'.encode(); (self.root / 'inputs/part.md').write_bytes(changed)
            with self.assertRaisesRegex(ValueError, 'hash differs'):
                stage(self.c, r)
        import datetime
        last = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=16)).isoformat()
        remote_root = pathlib.Path(self.c['remote']['root'])
        save(remote_root / 'progress.json', {'inputHash': handoff['inputHash'], 'completedChunks': 5, 'totalChunks': 10, 'phase': 'generating', 'lastProgressAt': last})
        save(pathlib.Path(self.c['workDir']) / 'last-notified.json', {'inputHash': handoff['inputHash'], 'completedChunks': 2})
        state = monitor(self.c, r)
        self.assertEqual(state['generationPercent'], 50.0)
        self.assertEqual(state['deltaChunksSinceNotification'], 3)
        self.assertTrue(state['needsInvestigation'])

    def test_paused_machine_monitor_does_not_exec(self):
        self.c['machine'] = {'statusArgv': [sys.executable, '-c', 'print(\'{"state":"suspended","operationId":null}\')']}
        remote = Remote(self.c, 'api')
        with patch.object(remote, 'call', side_effect=AssertionError('Paused machine must not receive exec')):
            state = monitor(self.c, remote)
            self.assertTrue(state['machineInactive'])
            with self.assertRaisesRegex(RuntimeError, 'not ready'):
                remote.require_running()

    def test_install_registers_only_without_starting_or_killing(self):
        root=pathlib.Path(self.c['remote']['root']);root.mkdir()
        save(root/'runtime.json',{'jobId':self.c['jobId'],'root':str(root)})
        payload={'op':'install','root':str(root),'repo':'/data/fixture/repo','jobId':self.c['jobId'],
                 'engineRun':'/opt/fixture/run','node':'/usr/bin/node','user':'fixture','threads':2,'port':50021}
        with patch.object(remote_ops.subprocess,'run') as run,patch.object(remote_ops.shutil,'which',return_value='/usr/bin/flock'):
            result=remote_ops.main(payload)
            self.assertFalse(result['started'])
            writes=[call.kwargs['input'] for call in run.call_args_list if call.args[0][:3]==['sudo','-n','tee']]
            self.assertEqual(len(writes),2)
            self.assertTrue(all('--host 0.0.0.0' not in text for text in writes))
            self.assertFalse(any('start' in call.args[0] or 'kill' in call.args[0] for call in run.call_args_list))

    def test_completed_job_cannot_be_restarted(self):
        root=pathlib.Path(self.c['remote']['root']);root.mkdir()
        save(root/'runtime.json',{'jobId':self.c['jobId'],'root':str(root)})
        save(root/'completion.json',{'phase':'ready-for-import'})
        with patch.object(remote_ops.subprocess,'run') as run:
            with self.assertRaisesRegex(ValueError,'completion record'):
                remote_ops.main({'op':'resume','root':str(root),'jobId':self.c['jobId'],'minFreeBytes':1})
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
