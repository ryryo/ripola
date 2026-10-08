#!/usr/bin/env python3
"""Read-only readiness check; never download, install or synthesize audio."""
import argparse
import importlib.metadata
import json
import platform
from pathlib import Path
import re
import shutil
import sys
from urllib.parse import unquote, urlparse

def runtime_platform():
    profiles = json.loads(Path(__file__).with_name('alignment-platforms.json').read_text())
    if sys.version_info[:2] != (3, 13) or sys.implementation.name != 'cpython':
        raise ValueError('unsupported-runtime')
    for profile in profiles.values():
        if profile['system'] == platform.system() and profile['machine'] == platform.machine():
            return profile
    raise ValueError('unsupported-runtime')

def locked_dependencies(requirements):
    for line in requirements.splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        match = re.match(r'^([a-zA-Z0-9_-]+)==([^\s]+)', line)
        if match:
            yield match.groups()
            continue
        direct = re.match(r'^torch @ (https://download\.pytorch\.org/whl/cpu/torch-[^\s]+)', line)
        if direct:
            wheel = unquote(urlparse(direct[1]).path.rsplit('/', 1)[-1])
            yield 'torch', wheel.split('-')[1]
            continue
        raise ValueError('invalid-dependency-lock')

def dependencies():
    profile = runtime_platform()
    lock = Path(__file__).with_name(profile['requirements']).read_text()
    for name, version in locked_dependencies(lock):
        if importlib.metadata.version(name) != version:
            raise ValueError('dependency-version-mismatch')
    import numpy
    import safetensors
    import torch
    if profile['system'] == 'Linux' and (torch.__version__ != '2.8.0+cpu' or torch.version.cuda is not None):
        raise ValueError('cpu-runtime-required')
    from transformers import Wav2Vec2CTCTokenizer, Wav2Vec2FeatureExtractor, Wav2Vec2ForCTC
    assert all([numpy, safetensors, torch, Wav2Vec2CTCTokenizer, Wav2Vec2FeatureExtractor, Wav2Vec2ForCTC])

def model(directory):
    import align_audio
    manifest = json.loads(Path(__file__).with_name('alignment-model.json').read_text())
    align_audio.verify_model(Path(directory), {'alignerVersion': manifest['alignerVersion']})

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir')
    parser.add_argument('--dependencies-only', action='store_true')
    parser.add_argument('--model-only', action='store_true')
    args = parser.parse_args()
    if not args.model_only:
        dependencies()
    if not args.dependencies_only:
        if not args.model_dir:
            raise ValueError('model-dir-required')
        model(args.model_dir)
    if not args.dependencies_only and not args.model_only:
        if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
            raise ValueError('audio-tools-missing')
    print(json.dumps({'status': 'ready'}))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Errors may include private paths or environment values; return a bounded reason.
        print(json.dumps({'status': 'failed'}))
        sys.exit(1)
