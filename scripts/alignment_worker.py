"""Private JSON Lines worker protocol. Synchronous dispatch bounds model concurrency to one."""
import contextlib
import json
import sys

PROTOCOL_VERSION = 1
CONFIDENCE_MEANING = 'transcript-conditioned-ctc'
MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_RESPONSE_BYTES = 4 * 1024 * 1024


def serve(runtime, aligner_version, align, input_stream=None, output_stream=None):
    from alignment_runtime import ResourcesChanged
    source = input_stream or sys.stdin.buffer
    output = output_stream or sys.stdout

    def send(frame):
        data = json.dumps({'protocolVersion': PROTOCOL_VERSION, **frame}, ensure_ascii=False, allow_nan=False)
        if len(data.encode('utf-8')) > MAX_RESPONSE_BYTES:
            raise ValueError('Oversized response')
        output.write(data + '\n')
        output.flush()

    semantics = {'method': 'forced-alignment', 'confidenceMeaning': CONFIDENCE_MEANING}
    # Keep Python/library print diagnostics off the framing stream, including model load.
    with contextlib.redirect_stdout(sys.stderr):
        runtime.ensure_loaded(aligner_version)
    send({'type': 'ready', 'alignerVersion': aligner_version, **semantics})
    while True:
        line = source.readline(MAX_REQUEST_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_REQUEST_BYTES or not line.endswith(b'\n'):
            raise ValueError('Invalid request frame')
        frame = json.loads(line)
        if (not isinstance(frame, dict) or frame.get('protocolVersion') != PROTOCOL_VERSION
                or frame.get('type') != 'align' or not isinstance(frame.get('id'), str)
                or not 1 <= len(frame['id']) <= 100
                or any(not (c.isascii() and (c.isalnum() or c == '-')) for c in frame['id'])
                or not isinstance(frame.get('request'), dict)):
            raise ValueError('Invalid request envelope')
        try:
            with contextlib.redirect_stdout(sys.stderr):
                runtime.ensure_loaded(aligner_version)
                result = align(frame['request'], runtime)
            send({'type': 'result', 'id': frame['id'], 'result': result, **semantics})
        except ResourcesChanged:
            send({'type': 'error', 'id': frame['id'], 'code': 'resources-changed'})
            return
        except Exception as error:
            # Never send raw exceptions (paths/transcripts/env) over either channel.
            sys.stderr.write(f'Alignment request failed ({type(error).__name__}).\n')
            send({'type': 'error', 'id': frame['id'], 'code': 'request-failed'})


def run_worker(align):
    import os
    import runpy
    import shutil
    from pathlib import Path
    from alignment_runtime import ReazonRuntime
    # Preserve one framing fd, then direct even native/library stdout to stderr.
    with os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8', buffering=1) as output:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        with contextlib.redirect_stdout(sys.stderr):
            runpy.run_path(str(Path(__file__).with_name('check-alignment-runtime.py')))['dependencies']()
            if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
                raise ValueError('Audio tools missing')
            manifest = json.loads(Path(__file__).with_name('alignment-model.json').read_text())
            serve(ReazonRuntime(), manifest['alignerVersion'], align, output_stream=output)
