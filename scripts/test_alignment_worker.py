"""No model downloads: protocol, resident loader and one-shot output regression tests."""
import contextlib
import io
import json
import sys
import hashlib
from pathlib import Path
import subprocess
import tempfile
import wave
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import align_audio
from alignment_runtime import ReazonRuntime, ResourcesChanged
from alignment_worker import serve

VERSION = 'reazon-rs35kh-46afc596-ctc-v2'
REQUEST = {'schemaVersion': 1, 'offsetUnit': 'utf16', 'normalizedText': '窓😀',
           'normalizeVersion': 'ctc-ja-nfkc-v1', 'alignerVersion': VERSION}


class WorkerTests(unittest.TestCase):
    def test_two_requests_load_once_and_frame_logs_separately(self):
        class Runtime:
            loaded = False
            loads = 0
            def ensure_loaded(self, version):
                if not self.loaded:
                    print('mock load diagnostics')
                    self.loaded = True
                    self.loads += 1
        runtime = Runtime()
        def align(request, supplied):
            self.assertIs(supplied, runtime)
            print('mock inference diagnostics')
            return align_audio.unmatched(request, 1, 'test')
        frames = [{'protocolVersion': 1, 'type': 'align', 'id': str(i), 'request': REQUEST} for i in range(2)]
        source = io.BytesIO(b''.join(json.dumps(f).encode() + b'\n' for f in frames))
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(errors):
            serve(runtime, VERSION, align, source, output)
        values = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(runtime.loads, 1)
        self.assertEqual([v['type'] for v in values], ['ready', 'result', 'result'])
        self.assertEqual([v['id'] for v in values[1:]], ['0', '1'])
        self.assertTrue(all(v['confidenceMeaning'] == 'transcript-conditioned-ctc' for v in values))
        self.assertIn('mock inference diagnostics', errors.getvalue())

    def test_request_error_is_explicit_and_later_input_is_not_replayed(self):
        source = io.BytesIO(json.dumps({'protocolVersion': 1, 'type': 'align', 'id': 'failure', 'request': REQUEST}).encode() + b'\n')
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(errors):
            serve(SimpleNamespace(ensure_loaded=lambda _: None), VERSION,
                  Mock(side_effect=ValueError('private transcript /path secret')), source, output)
        values = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(values[-1], {'protocolVersion': 1, 'type': 'error', 'id': 'failure', 'code': 'request-failed'})
        self.assertNotIn('private', errors.getvalue() + output.getvalue())

    def test_resource_change_reports_error_and_exits_before_next_request(self):
        frames = [{'protocolVersion': 1, 'type': 'align', 'id': str(i), 'request': REQUEST} for i in range(2)]
        source = io.BytesIO(b''.join(json.dumps(f).encode() + b'\n' for f in frames))
        output = io.StringIO()
        align = Mock(side_effect=ResourcesChanged())
        serve(SimpleNamespace(ensure_loaded=lambda _: None), VERSION, align, source, output)
        self.assertEqual(align.call_count, 1)
        self.assertEqual(json.loads(output.getvalue().splitlines()[-1])['code'], 'resources-changed')
        self.assertTrue(source.read())

    def test_unknown_or_unterminated_frame_is_fatal(self):
        for frame in [b'{"protocolVersion":2}\n', b'{"protocolVersion":1}', b'[]\n', b'x' * (2 * 1024 * 1024 + 1)]:
            with self.subTest(frame=frame[:20]), self.assertRaises(ValueError):
                serve(SimpleNamespace(ensure_loaded=lambda _: None), VERSION, Mock(), io.BytesIO(frame), io.StringIO())

    def test_cli_still_emits_bare_result_json_and_newline(self):
        result = align_audio.unmatched(REQUEST, 1, 'test')
        output = io.StringIO()
        with patch.object(sys, 'argv', ['align_audio.py']), patch.object(sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(json.dumps(REQUEST).encode()))), patch.object(sys, 'stdout', output), patch.object(align_audio, 'align', return_value=result) as align:
            align_audio.main()
        self.assertEqual(json.loads(output.getvalue()), result)
        self.assertTrue(output.getvalue().endswith('\n'))
        align.assert_called_once_with(REQUEST)

    def test_actual_cli_size_fallback_has_legacy_result_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture.wav'
            with wave.open(str(path), 'wb') as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(b'\0\0' * 16000)
            request = {**REQUEST, 'normalizedText': '', 'audioPath': str(path),
                       'audioHash': hashlib.sha256(path.read_bytes()).hexdigest()}
            child = subprocess.run([sys.executable, str(Path(align_audio.__file__))],
                                   input=json.dumps(request).encode(), capture_output=True, timeout=30)
            self.assertEqual(child.returncode, 0)
            self.assertEqual(json.loads(child.stdout), align_audio.unmatched(request, 1, 'runtime-size-limit'))
            self.assertEqual(child.stderr, b'')

    def test_resident_loader_verifies_and_loads_all_components_only_once(self):
        runtime = ReazonRuntime('.')
        model = Mock()
        model.cpu.return_value.eval.return_value = model
        factories = {name: SimpleNamespace(from_pretrained=Mock(return_value=model)) for name in
                     ['Wav2Vec2CTCTokenizer', 'Wav2Vec2FeatureExtractor', 'Wav2Vec2ForCTC']}
        torch = SimpleNamespace(set_num_threads=Mock(), float32='float32')
        with patch('alignment_runtime.resource_signature', return_value=('v1',)), patch.object(align_audio, 'verify_model', return_value={'pad_token_id': 0}) as verify, patch.dict(sys.modules, {'torch': torch, 'transformers': SimpleNamespace(**factories)}):
            runtime.ensure_loaded(VERSION)
            runtime.ensure_loaded(VERSION)
            verify.assert_called_once()
            for factory in factories.values():
                factory.from_pretrained.assert_called_once()
                self.assertTrue(factory.from_pretrained.call_args.kwargs['local_files_only'])
            with patch('alignment_runtime.resource_signature', return_value=('v2',)), self.assertRaises(ResourcesChanged):
                runtime.ensure_loaded(VERSION)
            with self.assertRaises(ResourcesChanged):
                runtime.ensure_loaded('another-version')


if __name__ == '__main__':
    unittest.main()
