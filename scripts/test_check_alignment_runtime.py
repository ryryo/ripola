"""Platform and lock contracts; no downloads or package installation."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('check', Path(__file__).with_name('check-alignment-runtime.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class RuntimeTests(unittest.TestCase):
    def platform(self, system, machine, version=(3, 13)):
        return (patch.object(check.platform, 'system', return_value=system),
                patch.object(check.platform, 'machine', return_value=machine),
                patch.object(check.sys, 'version_info', version))

    def test_platform_lock_selection(self):
        for system, machine, lock in [('Darwin', 'arm64', 'alignment-requirements.txt'),
                                      ('Linux', 'x86_64', 'alignment-requirements-linux-x64.txt')]:
            system_patch, machine_patch, version_patch = self.platform(system, machine)
            with system_patch, machine_patch, version_patch:
                self.assertEqual(check.runtime_platform()['requirements'], lock)

    def test_unsupported_platform_and_python_rejected_before_metadata(self):
        for system, machine, version in [('Windows', 'AMD64', (3, 13)), ('Linux', 'aarch64', (3, 13)),
                                         ('Darwin', 'x86_64', (3, 13)), ('Linux', 'x86_64', (3, 12))]:
            system_patch, machine_patch, version_patch = self.platform(system, machine, version)
            with system_patch, machine_patch, version_patch, patch.object(check.importlib.metadata, 'version') as metadata:
                with self.assertRaisesRegex(ValueError, 'unsupported-runtime'):
                    check.dependencies()
                metadata.assert_not_called()

    def test_locks_keep_distinct_torch_local_versions_and_all_versions_pinned(self):
        mac = dict(check.locked_dependencies(Path(__file__).with_name('alignment-requirements.txt').read_text()))
        linux = dict(check.locked_dependencies(Path(__file__).with_name('alignment-requirements-linux-x64.txt').read_text()))
        self.assertEqual(mac['torch'], '2.8.0')
        self.assertEqual(linux['torch'], '2.8.0+cpu')
        for name, version in [('numpy', '2.3.5'), ('transformers', '4.57.6'), ('safetensors', '0.6.2')]:
            self.assertEqual(linux[name], version)
            self.assertEqual(mac[name], version)
        self.assertFalse(any(name.startswith('nvidia-') or name in ['triton', 'torchaudio', 'librosa'] for name in linux))
        with self.assertRaisesRegex(ValueError, 'invalid-dependency-lock'):
            list(check.locked_dependencies('torch>=2.8.0'))

    def test_linux_real_import_contract_and_cpu_check(self):
        system_patch, machine_patch, version_patch = self.platform('Linux', 'x86_64')
        versions = dict(check.locked_dependencies(Path(__file__).with_name('alignment-requirements-linux-x64.txt').read_text()))
        torch = types.SimpleNamespace(__version__='2.8.0+cpu', version=types.SimpleNamespace(cuda=None))
        transformers = types.SimpleNamespace(Wav2Vec2CTCTokenizer=object(), Wav2Vec2FeatureExtractor=object(), Wav2Vec2ForCTC=object())
        with system_patch, machine_patch, version_patch, patch.dict(sys.modules, {'numpy': object(), 'safetensors': object(), 'torch': torch, 'transformers': transformers}), patch.object(check.importlib.metadata, 'version', side_effect=versions.__getitem__) as metadata:
            check.dependencies()
            self.assertEqual(metadata.call_count, len(versions))
            torch.version.cuda = '12.8'
            with self.assertRaisesRegex(ValueError, 'cpu-runtime-required'):
                check.dependencies()
            torch.version.cuda = None
            versions['torch'] = '2.8.0'
            with self.assertRaisesRegex(ValueError, 'dependency-version-mismatch'):
                check.dependencies()


if __name__ == '__main__':
    unittest.main()
