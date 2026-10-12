/** Self-authored tones/candidates exercise QA behavior, not a recognizer's acoustic accuracy. */
export const QA_TEXT = '今日は図書館で本を読みます。明日は公園を散歩します。';
export const QA_CANDIDATES = { normal: QA_TEXT, omitted: '今日は本を読みます。明日は公園を散歩します。', repeated: '今日は図書館で図書館で本を読みます。明日は公園を散歩します。' };
export function qaWave(seconds = 5, kind: 'normal' | 'silence' | 'clipping' | 'pause' = 'normal'): Uint8Array {
  const rate = 16000, frames = Math.round(seconds * rate), bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const time = i / rate;
    const sample = kind === 'silence' || (kind === 'pause' && time > 1 && time < 4) ? 0 : kind === 'clipping' ? (Math.sin(i * .12) >= 0 ? 32767 : -32768) : Math.round(5000 * Math.sin(i * .1 + i * i * .0000017) * (.8 + .2 * Math.sin(i * .00017)));
    bytes.writeInt16LE(sample, 44 + i * 2);
  }
  return bytes;
}
