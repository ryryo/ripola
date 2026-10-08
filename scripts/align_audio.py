#!/usr/bin/env python3
"""Offline Japanese CTC forced alignment of a supplied transcript, without ASR replacement.

stdin/stdout is the versioned JSON protocol used by core/alignment-adapter.ts.
Only known characters are aligned; no wildcard or interpolated timestamps count as aligned.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import wave

SAMPLE_RATE = 16000
PADDING_SECONDS = 0.5
MIN_CONFIDENCE = 0.75
MAX_DURATION_SECONDS = 60
MAX_CHARACTERS = 512


def sha256_file(path):
    hasher = hashlib.sha256()
    with path.open('rb') as file:
        for block in iter(lambda: file.read(1024 * 1024), b''):
            hasher.update(block)
    return hasher.hexdigest()


def utf16_ranges(text):
    offset = 0
    result = []
    for char in text:
        end = offset + len(char.encode('utf-16-le')) // 2
        result.append((offset, end))
        offset = end
    return result


def token_ranges(text, tokens):
    """The pinned tokenizer includes multi-character added tokens such as きます.

    Require exact reconstruction before projecting those tokens back to UTF-16 ranges.
    A shared token may cover several original display units; Node groups that relation.
    """
    if ''.join(tokens) != text or any(not token for token in tokens):
        return None
    offset = 0
    result = []
    for token in tokens:
        end = offset + len(token.encode('utf-16-le')) // 2
        result.append((offset, end))
        offset = end
    return result


def unmatched(request, duration, reason):
    return {
        'schemaVersion': 1, 'alignerVersion': request['alignerVersion'],
        'normalizeVersion': request['normalizeVersion'], 'offsetUnit': 'utf16',
        'normalizedText': request['normalizedText'], 'durationSeconds': duration,
        'segments': [{'start': start, 'end': end, 'confidence': 0, 'status': 'unmatched'}
                     for start, end in utf16_ranges(request['normalizedText'])],
        'warnings': [reason],
    }


def ctc_path(emission, tokens, blank_id=0):
    """Viterbi through blank/token states, including repeated-label blank constraints.

    Free leading/trailing blanks are permitted. Returns one frame list per target character.
    Memory is bounded by the explicit duration/character caps before model inference.
    """
    import numpy as np
    frames, _ = emission.shape
    labels = np.full(2 * len(tokens) + 1, blank_id, dtype=np.int32)
    labels[1::2] = tokens
    states = len(labels)
    if frames < len(tokens) + sum(a == b for a, b in zip(tokens, tokens[1:])):
        return None
    previous = np.full(states, -np.inf, dtype=np.float64)
    previous[0] = 0
    backpointers = np.zeros((frames, states), dtype=np.uint8)
    # A two-state jump is allowed only into a token differing from its predecessor.
    can_skip = np.zeros(states, dtype=bool)
    can_skip[2:] = (labels[2:] != blank_id) & (labels[2:] != labels[:-2])
    for frame in range(frames):
        one = np.concatenate(([-np.inf], previous[:-1]))
        two = np.concatenate(([-np.inf, -np.inf], previous[:-2]))
        two[~can_skip] = -np.inf
        choices = np.stack((previous, one, two))
        steps = np.argmax(choices, axis=0)
        previous = np.max(choices, axis=0) + emission[frame, labels]
        backpointers[frame] = steps
    state = states - 1 if previous[-1] >= previous[-2] else states - 2
    if not np.isfinite(previous[state]):
        return None
    paths = [[] for _ in tokens]
    for frame in range(frames - 1, -1, -1):
        if state % 2:
            paths[(state - 1) // 2].append(frame)
        state -= int(backpointers[frame, state])
    if state != 0 or any(not path for path in paths):
        return None
    return [list(reversed(path)) for path in paths]


def verify_model(model_dir, request):
    manifest = json.loads(Path(__file__).with_name('alignment-model.json').read_text())
    if request['alignerVersion'] != manifest['alignerVersion']:
        raise ValueError('Aligner version does not match the repository-pinned model')
    for entry in manifest['files']:
        path = model_dir / entry['filename']
        if not path.is_file() or path.stat().st_size != entry['bytes'] or sha256_file(path) != entry['sha256']:
            raise ValueError('Model files do not match the repository-pinned hashes')
    config = json.loads((model_dir / 'config.json').read_text())
    if config.get('auto_map') or config.get('architectures') != ['Wav2Vec2ForCTC'] or config.get('model_type') != 'wav2vec2':
        raise ValueError('Only the pinned standard Wav2Vec2ForCTC architecture is supported')
    return config


def speech_activity(samples, duration, sample_rate=SAMPLE_RATE):
    """PCM activity, not word recognition: 10 ms RMS, 80 ms gap bridge, 10 ms edge pad."""
    import numpy as np
    width = max(1, round(sample_rate * .01))
    padded = np.pad(samples, (0, (-len(samples)) % width))
    rms = np.sqrt(np.mean(padded.reshape(-1, width) ** 2, axis=1)) if len(padded) else np.array([])
    threshold = max(.0015, min(.01, float(np.percentile(rms, 90)) * .06)) if len(rms) else .0015
    active = rms >= threshold
    indices = np.flatnonzero(active)
    for left, right in zip(indices, indices[1:]):
        if right - left <= 9:
            active[left:right + 1] = True
    intervals = []
    start = None
    for index, value in enumerate(np.concatenate((active, [False]))):
        if value and start is None:
            start = index
        if not value and start is not None:
            if index - start >= 3:
                begin, end = max(0, (start - 1) * .01), min(duration, (index + 1) * .01)
                if intervals and begin <= intervals[-1]['endSeconds']:
                    intervals[-1]['endSeconds'] = end
                else:
                    intervals.append({'startSeconds': begin, 'endSeconds': end})
            start = None
    return {'version': 'pcm-rms-v1', 'frameSeconds': .01, 'thresholdRms': threshold, 'intervals': intervals}


def align(request):
    if request.get('schemaVersion') != 1 or request.get('offsetUnit') != 'utf16' or request.get('normalizeVersion') != 'ctc-ja-nfkc-v1':
        raise ValueError('Unsupported alignment request schema')
    text = request['normalizedText']
    if not isinstance(text, str):
        raise ValueError('normalizedText must be a string')
    audio_path = Path(request['audioPath']).resolve(strict=True)
    if not audio_path.is_file() or audio_path.stat().st_size > 64 * 1024 * 1024:
        raise ValueError('Invalid or oversized private WAV')
    if sha256_file(audio_path) != request['audioHash']:
        raise ValueError('WAV hash does not match the cached audio')
    with wave.open(str(audio_path), 'rb') as audio:
        duration = audio.getnframes() / audio.getframerate()
        if audio.getcomptype() != 'NONE' or audio.getsampwidth() not in (1, 2, 3, 4):
            raise ValueError('Only PCM WAV is supported')
    # Limit costly transformer attention before loading or processing long audio.
    if not text or duration <= 0 or duration > MAX_DURATION_SECONDS or len(text) > MAX_CHARACTERS:
        return unmatched(request, duration, 'runtime-size-limit')
    model_dir = Path(os.environ['RSVP_ALIGNMENT_MODEL_DIR']).resolve(strict=True)
    config = verify_model(model_dir, request)
    import numpy as np
    # The already installed ffmpeg converts only the server-owned WAV; no shell/network input.
    decoded = subprocess.run(
        ['ffmpeg', '-v', 'error', '-nostdin', '-i', str(audio_path), '-ac', '1',
         '-ar', str(SAMPLE_RATE), '-f', 'f32le', 'pipe:1'],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
    ).stdout
    samples = np.frombuffer(decoded, dtype='<f4').copy()
    if len(samples) > (MAX_DURATION_SECONDS + 1) * SAMPLE_RATE or not np.isfinite(samples).all():
        raise ValueError('Invalid decoded PCM')
    if not len(samples) or float(np.sqrt(np.mean(samples ** 2))) < 0.0015:
        return unmatched(request, duration, 'silence-or-too-quiet')
    # Known classes + local_files_only + safetensors exclude custom remote code and pickle weights.
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    import torch
    from transformers import Wav2Vec2CTCTokenizer, Wav2Vec2FeatureExtractor, Wav2Vec2ForCTC
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    tokenizer = Wav2Vec2CTCTokenizer.from_pretrained(str(model_dir), local_files_only=True)
    token_strings = tokenizer.tokenize(text)
    tokens = tokenizer.convert_tokens_to_ids(token_strings)
    ranges = token_ranges(text, token_strings)
    if ranges is None or any(token in tokenizer.all_special_ids or token == config['pad_token_id'] for token in tokens):
        # No wildcard, guessed reading or character-by-character replacement for model subwords.
        return unmatched(request, duration, 'unknown-vocabulary-character')
    feature_extractor = Wav2Vec2FeatureExtractor.from_pretrained(str(model_dir), local_files_only=True)
    model = Wav2Vec2ForCTC.from_pretrained(
        str(model_dir), local_files_only=True, use_safetensors=True,
        trust_remote_code=False, attn_implementation='eager', dtype=torch.float32,
    ).cpu().eval()
    padded = np.pad(samples, int(PADDING_SECONDS * SAMPLE_RATE))
    values = feature_extractor(padded, sampling_rate=SAMPLE_RATE, return_tensors='pt').input_values
    with torch.inference_mode():
        emission = model(values).logits[0].log_softmax(-1).cpu().numpy()
    paths = ctc_path(emission, tokens, config['pad_token_id'])
    if paths is None:
        return unmatched(request, duration, 'no-valid-ctc-path')
    # Wav2vec2 convolutions have a known sample stride; do not scale timestamps by text length.
    stride_seconds = math.prod(config['conv_stride']) / SAMPLE_RATE
    segments = []
    for (start, end), token, path in zip(ranges, tokens, paths):
        confidence = float(np.exp(emission[path, token]).mean())
        start_seconds = max(0, min(duration, path[0] * stride_seconds - PADDING_SECONDS))
        end_seconds = max(0, min(duration, (path[-1] + 1) * stride_seconds - PADDING_SECONDS))
        status = 'aligned' if confidence >= MIN_CONFIDENCE and end_seconds > start_seconds else 'low-confidence'
        segment = {'start': start, 'end': end, 'confidence': confidence, 'status': status}
        if end_seconds > start_seconds:
            segment.update({'startSeconds': start_seconds, 'endSeconds': end_seconds})
        segments.append(segment)
    activity = speech_activity(samples, duration)
    return {'schemaVersion': 1, 'alignerVersion': request['alignerVersion'],
            'normalizeVersion': request['normalizeVersion'], 'offsetUnit': 'utf16',
            'normalizedText': text, 'durationSeconds': duration, 'segments': segments,
            **({'speechActivity': activity} if activity['intervals'] else {})}


def main():
    data = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise ValueError('Oversized request')
    result = align(json.loads(data))
    sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False) + '\n')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # No transcript, private path, environment, or raw library error in diagnostics.
        sys.stderr.write(f'Alignment failed ({type(error).__name__}).\n')
        sys.exit(1)
