/**
 * Cut an MP3 down to its first N seconds on frame boundaries, so the server
 * only ever sends the part of the song a player has unlocked.
 *
 * Handles MPEG 1/2/2.5 Layer III (Deezer previews are MPEG-1 Layer III).
 * Skips a leading ID3v2 tag and the Xing/Info frame (its frame count would be
 * wrong for the cut file).
 */

const BITRATES: Record<"v1" | "v2", number[]> = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

export interface FrameHeader {
  length: number;
  samples: number;
  sampleRate: number;
}

export function parseFrameHeader(buf: Buffer, offset: number): FrameHeader | null {
  if (offset + 4 > buf.length) return null;
  if (buf[offset] !== 0xff || (buf[offset + 1] & 0xe0) !== 0xe0) return null;
  const version = (buf[offset + 1] >> 3) & 0x03; // 0=2.5, 1=reserved, 2=2, 3=1
  const layer = (buf[offset + 1] >> 1) & 0x03; // 1 = Layer III
  if (version === 1 || layer !== 1) return null;
  const bitrateIndex = (buf[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (buf[offset + 2] >> 2) & 0x03;
  const padding = (buf[offset + 2] >> 1) & 0x01;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;

  const isV1 = version === 3;
  const bitrate = BITRATES[isV1 ? "v1" : "v2"][bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][sampleRateIndex];
  const samples = isV1 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
  if (length < 24) return null;
  return { length, samples, sampleRate };
}

function id3v2Size(buf: Buffer): number {
  if (buf.length < 10 || buf.toString("latin1", 0, 3) !== "ID3") return 0;
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const footer = buf[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

function isXingFrame(buf: Buffer, offset: number, length: number): boolean {
  const frame = buf.subarray(offset, offset + Math.min(length, 64)).toString("latin1");
  return frame.includes("Xing") || frame.includes("Info");
}

/** Find the first real frame: a header followed by another valid header. */
function findFirstFrame(buf: Buffer, from: number): number {
  for (let i = from; i < buf.length - 4; i++) {
    const h = parseFrameHeader(buf, i);
    if (h && parseFrameHeader(buf, i + h.length)) return i;
  }
  return -1;
}

export interface SliceResult {
  mp3: Buffer;
  /** Duration of the audio actually included, in seconds. */
  seconds: number;
}

/**
 * Return the frames covering at least `seconds` of audio (plus `marginSeconds`
 * so the decoder has enough to produce the full clip).
 */
export function sliceMp3(buf: Buffer, seconds: number, marginSeconds = 0.08): SliceResult {
  let offset = findFirstFrame(buf, id3v2Size(buf));
  if (offset < 0) throw new Error("No MP3 frames found");

  const first = parseFrameHeader(buf, offset)!;
  if (isXingFrame(buf, offset, first.length)) offset += first.length;

  const start = offset;
  const target = seconds + marginSeconds;
  let duration = 0;
  while (offset < buf.length && duration < target) {
    const h = parseFrameHeader(buf, offset);
    if (!h) break;
    if (offset + h.length > buf.length) break;
    offset += h.length;
    duration += h.samples / h.sampleRate;
  }
  return { mp3: buf.subarray(start, offset), seconds: duration };
}
