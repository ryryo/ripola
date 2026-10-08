import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Encode only in-memory synthetic tones. No book, library, speech service or model is used. */
export function browserMp3(wav: Buffer) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '64k', '-write_xing', '0', '-f', 'mp3', 'pipe:1'], { input: wav, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Browser media fixture requires ffmpeg with libmp3lame.');
  const bytes = result.stdout;
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
