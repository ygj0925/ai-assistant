export const waveMime = 'audio/wav';
export const waveLimit = 1024 * 1024;

const headerBytes = 44;
const invalidWave = '请选择不超过 1 MiB、最长 30 秒的 16 位 PCM WAV（单声道或双声道，8–48 kHz）。';

export function inspectWave(bytes: Uint8Array, canonical = false) {
  const body = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const deny = () => { throw new Error(invalidWave); };
  if (body.byteLength < headerBytes + 2 || body.byteLength > waveLimit) return deny();
  if (body.getUint32(0) !== 0x52494646 || body.getUint32(4, true) !== bytes.length - 8
    || body.getUint32(8) !== 0x57415645) return deny();

  let channels: 0 | 1 | 2 = 0;
  let sampleRate = 0;
  let dataOffset = 0;
  let dataLength = 0;
  let chunks = 0;
  for (let offset = 12; offset < bytes.length;) {
    if (bytes.length - offset < 8 || ++chunks > 64) return deny();
    const kind = body.getUint32(offset);
    const length = body.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length + (length & 1);
    if (end > bytes.length) return deny();
    if (kind === 0x666d7420) {
      if (sampleRate || (length !== 16 && length !== 18) || body.getUint16(start, true) !== 1
        || (length === 18 && body.getUint16(start + 16, true))) return deny();
      const channelCount = body.getUint16(start + 2, true);
      if (channelCount !== 1 && channelCount !== 2) return deny();
      channels = channelCount;
      sampleRate = body.getUint32(start + 4, true);
      const alignment = channels * 2;
      if (sampleRate < 8000 || sampleRate > 48000
        || body.getUint32(start + 8, true) !== sampleRate * alignment
        || body.getUint16(start + 12, true) !== alignment || body.getUint16(start + 14, true) !== 16) return deny();
    } else if (kind === 0x64617461) {
      if (dataOffset || !length) return deny();
      dataOffset = start;
      dataLength = length;
    } else if (canonical) return deny();
    offset = end;
  }
  if (!sampleRate || !channels || !dataOffset || dataLength % (channels * 2) ||
    (canonical && (dataOffset !== headerBytes || dataOffset + dataLength !== bytes.length))) return deny();
  const frames = dataLength / (channels * 2);
  if (frames > sampleRate * 30) return deny();
  return { sampleRate, channels, durationMillis: Math.ceil(frames * 1000 / sampleRate), dataOffset, frames };
}

export function wavePeaks(bytes: Uint8Array, layout: ReturnType<typeof inspectWave>) {
  const body = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const peaks = Array<number>(32).fill(0);
  const { frames, dataOffset, channels } = layout;
  for (let frame = 0; frame < frames; frame++) {
    const offset = dataOffset + frame * channels * 2;
    const sample = Math.abs(body.getInt16(offset, true));
    const peak = channels === 2 ? Math.max(sample, Math.abs(body.getInt16(offset + 2, true))) : sample;
    const index = Math.floor(frame * peaks.length / frames);
    peaks[index] = Math.max(peaks[index], peak);
  }
  return peaks.map((peak) => peak / 32768);
}

