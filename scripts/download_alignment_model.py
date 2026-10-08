#!/usr/bin/env python3
"""Explicit, bounded download of one pinned safetensors model; never run at playback."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import urllib.request


def digest(path):
    hasher = hashlib.sha256()
    with path.open('rb') as file:
        for block in iter(lambda: file.read(1024 * 1024), b''):
            hasher.update(block)
    return hasher.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir', type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(Path(__file__).with_name('alignment-model.json').read_text())
    destination = args.model_dir.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    pending = [entry for entry in manifest['files'] if not (
        (destination / entry['filename']).is_file()
        and (destination / entry['filename']).stat().st_size == entry['bytes']
        and digest(destination / entry['filename']) == entry['sha256'])]
    needed = sum(entry['bytes'] for entry in pending)
    if shutil.disk_usage(destination).free < needed + 512 * 1024 * 1024:
        raise RuntimeError('Insufficient free space for this model and a 512 MiB reserve')
    print(f"Pinned model: {manifest['modelId']}@{manifest['revision']}")
    print(f"License: {manifest['license']}; remaining download: {needed:,} bytes")
    for entry in pending:
        name = entry['filename']
        # Names come only from the repository-owned allowlist, never from a server response.
        if Path(name).name != name or not name.endswith(('.json', '.safetensors')):
            raise RuntimeError('Invalid model allowlist')
        target = destination / name
        temporary = destination / (name + '.download')
        try:
            url = f"https://huggingface.co/{manifest['modelId']}/resolve/{manifest['revision']}/{name}"
            with urllib.request.urlopen(url, timeout=60) as response, temporary.open('wb') as output:
                size = 0
                while block := response.read(1024 * 1024):
                    size += len(block)
                    if size > entry['bytes']:
                        raise RuntimeError('Model download exceeded the pinned size')
                    output.write(block)
                output.flush()
                os.fsync(output.fileno())
            if size != entry['bytes'] or digest(temporary) != entry['sha256']:
                raise RuntimeError('Model download did not match its pinned SHA256')
            temporary.replace(target)
            print(f'Verified: {name} ({size:,} bytes)')
        finally:
            temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
