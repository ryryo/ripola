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

def dependencies():
    if sys.version_info[:2] != (3, 13) or platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise ValueError('unsupported-runtime')
    for line in Path(__file__).with_name('alignment-requirements.txt').read_text().splitlines():
        match = re.match(r'^([a-zA-Z0-9_-]+)==([^\s]+)', line)
        if match and importlib.metadata.version(match[1]) != match[2]:
            raise ValueError('dependency-version-mismatch')
    import numpy
    import safetensors
    import torch
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
