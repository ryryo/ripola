"""One offline, pinned Reazon model. Inference has no reference-transcript input.

QA may use infer() and tokenizer.decode(argmax) in its own module. The alignment
Viterbi/confidence path remains transcript-conditioned and is not ASR accuracy.
"""
import json
import math
import os
from pathlib import Path


class ResourcesChanged(ValueError):
    pass


def resource_signature(model_dir):
    manifest_path = Path(__file__).with_name('alignment-model.json')
    manifest = json.loads(manifest_path.read_text())
    paths = [manifest_path, Path(__file__), Path(__file__).with_name('align_audio.py'),
             Path(__file__).with_name('alignment_worker.py')]
    paths += [model_dir / entry['filename'] for entry in manifest['files']]
    return tuple((str(path.resolve(strict=True)), path.stat().st_dev, path.stat().st_ino,
                  path.stat().st_size, path.stat().st_mtime_ns, path.stat().st_ctime_ns)
                 for path in paths)


class ReazonRuntime:
    def __init__(self, model_dir=None):
        self.model_dir = Path(model_dir or os.environ['RSVP_ALIGNMENT_MODEL_DIR']).resolve(strict=True)
        self.signature = None
        self.model = None

    def ensure_loaded(self, aligner_version):
        from align_audio import verify_model
        signature = resource_signature(self.model_dir)
        if self.model is not None:
            if signature != self.signature or aligner_version != self.aligner_version:
                raise ResourcesChanged('Pinned resources changed; start a new worker')
            return
        config = verify_model(self.model_dir, {'alignerVersion': aligner_version})
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['TRANSFORMERS_OFFLINE'] = '1'
        import torch
        from transformers import Wav2Vec2CTCTokenizer, Wav2Vec2FeatureExtractor, Wav2Vec2ForCTC
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        tokenizer = Wav2Vec2CTCTokenizer.from_pretrained(str(self.model_dir), local_files_only=True)
        extractor = Wav2Vec2FeatureExtractor.from_pretrained(str(self.model_dir), local_files_only=True)
        model = Wav2Vec2ForCTC.from_pretrained(
            str(self.model_dir), local_files_only=True, use_safetensors=True,
            trust_remote_code=False, attn_implementation='eager', dtype=torch.float32,
        ).cpu().eval()
        if resource_signature(self.model_dir) != signature:
            raise ResourcesChanged('Pinned resources changed while loading')
        self.config, self.tokenizer, self.feature_extractor = config, tokenizer, extractor
        self.torch, self.model = torch, model
        self.aligner_version, self.signature = aligner_version, signature

    def infer(self, samples):
        """Return audio-only log probabilities; no forced target enters inference."""
        import numpy as np
        from align_audio import MAX_DURATION_SECONDS, PADDING_SECONDS, SAMPLE_RATE
        if self.model is None:
            raise ValueError('Load the pinned model before inference')
        self.ensure_loaded(self.aligner_version)
        if (not len(samples) or len(samples) > (MAX_DURATION_SECONDS + 1) * SAMPLE_RATE
                or not np.isfinite(samples).all()):
            raise ValueError('Invalid or oversized decoded PCM')
        padded = np.pad(samples, int(PADDING_SECONDS * SAMPLE_RATE))
        values = self.feature_extractor(padded, sampling_rate=SAMPLE_RATE, return_tensors='pt').input_values
        with self.torch.inference_mode():
            emission = self.model(values).logits[0].log_softmax(-1).cpu().numpy()
        if not np.isfinite(emission).all():
            raise ValueError('Invalid emission')
        return emission

    @property
    def stride_seconds(self):
        from align_audio import SAMPLE_RATE
        return math.prod(self.config['conv_stride']) / SAMPLE_RATE
