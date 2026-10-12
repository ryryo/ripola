import { join } from 'node:path';
import { localReazonAsr } from '../../src/generation/audio-quality/runtime.ts';

const directory = process.argv[2];
const adapter = localReazonAsr({
  alignmentPython: process.execPath,
  alignmentModelDir: directory,
  alignmentScript: join(directory, 'align_audio.py'),
});
await adapter.transcribe('fixture.wav', 'a'.repeat(64));
