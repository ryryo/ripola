#!/usr/bin/env python3
"""Pinned, offline audio-only greedy CTC. No transcript input and no downloads."""
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys

VERSION = 'reazon-rs35kh-46afc596-greedy-v1'


def greedy_runs(ids, blank):
    """Collapse adjacent labels before removing blanks, preserving repeated spoken labels."""
    runs = []
    previous = None
    for frame, label in enumerate(ids):
        label = int(label)
        if label != previous:
            if label != blank:
                runs.append((label, frame, frame + 1))
        elif label != blank:
            token, begin, _ = runs[-1]
            runs[-1] = (token, begin, frame + 1)
        previous = label
    return runs


def transcribe(request):
    if set(request) != {'schemaVersion', 'audioPath', 'mediaHash'} or request['schemaVersion'] != 1:
        raise ValueError('Invalid audio-only request')
    path = Path(request['audioPath']).resolve(strict=True)
    if not path.is_file() or path.stat().st_size > 64 * 1024 * 1024:
        raise ValueError('Invalid audio input')
    if hashlib.sha256(path.read_bytes()).hexdigest() != request['mediaHash']:
        raise ValueError('Audio hash mismatch')
    manifest = json.loads(Path(__file__).with_name('alignment-model.json').read_text())
    if manifest['modelId'] != 'reazon-research/japanese-wav2vec2-base-rs35kh' or manifest['revision'] != '46afc596052b612293c8db256b3a69447a2f57dc':
        raise ValueError('ASR version does not match the pinned model revision')
    from align_audio import verify_model
    model_dir = Path(os.environ['RSVP_ALIGNMENT_MODEL_DIR']).resolve(strict=True)
    verify_model(model_dir, {'alignerVersion': manifest['alignerVersion']})
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    import numpy as np
    if path.suffix not in ('.wav', '.mp3'):
        raise ValueError('Unsupported audio format')
    decoded = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
                              '-f', 'wav' if path.suffix == '.wav' else 'mp3', '-i', str(path), '-t', '30.1',
                              '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'],
                             check=True, capture_output=True, timeout=30).stdout
    samples = np.frombuffer(decoded, dtype='<f4').copy()
    if not len(samples) or len(samples) > 30 * 16000 or not np.isfinite(samples).all():
        raise ValueError('ASR requires 0-30 seconds of finite PCM')
    import torch
    from transformers import Wav2Vec2CTCTokenizer, Wav2Vec2FeatureExtractor, Wav2Vec2ForCTC
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    tokenizer = Wav2Vec2CTCTokenizer.from_pretrained(str(model_dir), local_files_only=True)
    extractor = Wav2Vec2FeatureExtractor.from_pretrained(str(model_dir), local_files_only=True)
    model = Wav2Vec2ForCTC.from_pretrained(str(model_dir), local_files_only=True, use_safetensors=True,
                                        trust_remote_code=False, attn_implementation='eager', dtype=torch.float32).cpu().eval()
    values = extractor(np.pad(samples, 8000), sampling_rate=16000, return_tensors='pt').input_values
    with torch.inference_mode():
        probabilities = model(values).logits[0].softmax(-1).cpu().numpy()
    ids = probabilities.argmax(-1)
    runs = greedy_runs(ids, model.config.pad_token_id)
    score = float(np.mean([probabilities[begin:end, token].mean() for token, begin, end in runs])) if runs else 0
    if not math.isfinite(score):
        raise ValueError('Invalid token posterior')
    text = tokenizer.decode(ids.tolist(), skip_special_tokens=True)
    if len(text) > 4000:
        raise ValueError('Oversized ASR candidate')
    return {'schemaVersion': 1, 'method': 'audio-only-greedy-ctc', 'version': VERSION,
            'mediaHash': request['mediaHash'], 'text': text, 'tokenScore': score}


if __name__ == '__main__':
    try:
        data = sys.stdin.buffer.read(4097)
        if len(data) > 4096:
            raise ValueError('Oversized request')
        print(json.dumps(transcribe(json.loads(data))))
    except Exception:
        # Do not log private paths, env, transcript or raw transformer diagnostics.
        print(json.dumps({'status': 'indeterminate', 'reason': 'offline-asr-failed-or-size-limit'}))
        sys.exit(1)
