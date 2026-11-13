/**
 * Cut an AAC-in-MP4 file (.m4a, as served by Apple's preview CDN) down to its
 * first N seconds, so the server only ever sends what a player has unlocked.
 *
 * An MP4 can't simply be truncated: the sample tables in `moov` describe the
 * whole file. Instead the AAC frames are pulled out of `mdat` using those
 * tables and re-wrapped as an ADTS stream (each frame behind a 7-byte header),
 * a format every browser's decodeAudioData accepts and that can end anywhere.
 */

interface Box {
  type: string;
  /** Start of the box's payload. */
  start: number;
  end: number;
}

function* boxes(buf: Buffer, start: number, end: number): Generator<Box> {
  let at = start;
  while (at + 8 <= end) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) return;
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at; // box runs to the end of the file
    }
    if (size < header || at + size > end) return;
    yield { type, start: at + header, end: at + size };
    at += size;
  }
}

function find(buf: Buffer, parent: Box, ...path: string[]): Box | null {
  let current = parent;
  for (const type of path) {
    let next: Box | null = null;
    for (const box of boxes(buf, current.start, current.end)) {
      if (box.type === type) {
        next = box;
        break;
      }
    }
    if (!next) return null;
    current = next;
  }
  return current;
}

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

interface AacConfig {
  /** MPEG-4 audio object type (2 = AAC-LC). */
  objectType: number;
  sampleRateIndex: number;
  channels: number;
}

/** Read the AudioSpecificConfig out of the esds box inside the mp4a sample entry. */
function aacConfig(buf: Buffer, stsd: Box): AacConfig {
  // stsd: version/flags(4) entry_count(4), then the first sample entry.
  const entry = boxes(buf, stsd.start + 8, stsd.end).next().value as Box | undefined;
  if (!entry || entry.type !== "mp4a") throw new Error("Not an AAC (mp4a) track");
  // AudioSampleEntry: reserved(6) data_ref(2) reserved(8) channels(2) samplesize(2) pre_defined(2) reserved(2) rate(4)
  const channelsFallback = buf.readUInt16BE(entry.start + 16);
  const rateFallback = buf.readUInt16BE(entry.start + 24);
  const fallback: AacConfig = {
    objectType: 2,
    sampleRateIndex: Math.max(0, SAMPLE_RATES.indexOf(rateFallback)),
    channels: channelsFallback,
  };

  const esds = find(buf, { type: "mp4a", start: entry.start + 28, end: entry.end }, "esds");
  if (!esds) return fallback;

  // Descriptors: tag(1) + size in 1-4 bytes (7 bits each, high bit = more).
  let at = esds.start + 4;
  const descriptor = () => {
    const tag = buf[at++];
    let size = 0;
    for (let i = 0; i < 4; i++) {
      const b = buf[at++];
      size = (size << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return { tag, size };
  };
  try {
    const es = descriptor();
    if (es.tag !== 0x03) return fallback;
    const flags = buf[at + 2];
    at += 3;
    if (flags & 0x80) at += 2; // dependsOn_ES_ID
    if (flags & 0x40) at += 1 + buf[at]; // URL
    if (flags & 0x20) at += 2; // OCR_ES_ID
    if (descriptor().tag !== 0x04) return fallback;
    at += 13; // objectTypeIndication, streamType, bufferSize, max/avg bitrate
    const specific = descriptor();
    if (specific.tag !== 0x05 || specific.size < 2 || at + 2 > esds.end) return fallback;
    const bits = buf.readUInt16BE(at);
    const objectType = bits >> 11;
    const sampleRateIndex = (bits >> 7) & 0x0f;
    const channels = (bits >> 3) & 0x0f;
    if (objectType < 1 || objectType > 4 || sampleRateIndex > 12 || channels < 1 || channels > 7) return fallback;
    return { objectType, sampleRateIndex, channels };
  } catch {
    return fallback;
  }
}

function adtsHeader(config: AacConfig, payloadBytes: number): Buffer {
  const length = payloadBytes + 7;
  const h = Buffer.alloc(7);
  h[0] = 0xff;
  h[1] = 0xf1; // MPEG-4, layer 0, no CRC
  h[2] = ((config.objectType - 1) << 6) | (config.sampleRateIndex << 2) | (config.channels >> 2);
  h[3] = ((config.channels & 0x03) << 6) | (length >> 11);
  h[4] = (length >> 3) & 0xff;
  h[5] = ((length & 0x07) << 5) | 0x1f;
  h[6] = 0xfc;
  return h;
}

export interface AacSlice {
  /** ADTS AAC stream. */
  aac: Buffer;
  /** Duration of the audio included, in seconds. */
  seconds: number;
}

/**
 * Return the AAC frames covering at least `seconds` of audio (plus
 * `marginSeconds`, which covers the encoder's priming silence), as ADTS.
 * Pass Infinity for the whole file.
 */
export function sliceM4a(buf: Buffer, seconds: number, marginSeconds = 0.1): AacSlice {
  const root: Box = { type: "", start: 0, end: buf.length };
  const moov = find(buf, root, "moov");
  if (!moov) throw new Error("No moov box: not an MP4 file");

  // The first track with an mp4a sample entry.
  let stbl: Box | null = null;
  let mdhd: Box | null = null;
  for (const trak of boxes(buf, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;
    const candidate = find(buf, trak, "mdia", "minf", "stbl");
    const stsd = candidate && find(buf, candidate, "stsd");
    if (!candidate || !stsd) continue;
    const entry = boxes(buf, stsd.start + 8, stsd.end).next().value as Box | undefined;
    if (entry?.type === "mp4a") {
      stbl = candidate;
      mdhd = find(buf, trak, "mdia", "mdhd");
      break;
    }
  }
  if (!stbl || !mdhd) throw new Error("No AAC audio track found");

  const config = aacConfig(buf, find(buf, stbl, "stsd")!);
  const stsz = find(buf, stbl, "stsz");
  const stsc = find(buf, stbl, "stsc");
  const stco = find(buf, stbl, "stco");
  const co64 = find(buf, stbl, "co64");
  const stts = find(buf, stbl, "stts");
  if (!stsz || !stsc || !(stco || co64)) throw new Error("MP4 sample tables are missing");

  // Seconds per AAC frame: stts sample_delta over the media timescale.
  const version = buf[mdhd.start];
  const timescale = buf.readUInt32BE(mdhd.start + (version === 1 ? 20 : 12));
  const delta = stts && buf.readUInt32BE(stts.start + 4) > 0 ? buf.readUInt32BE(stts.start + 12) : 1024;
  const frameSeconds = delta / (timescale || SAMPLE_RATES[config.sampleRateIndex]);

  const uniformSize = buf.readUInt32BE(stsz.start + 4);
  const sampleCount = buf.readUInt32BE(stsz.start + 8);
  const sizeOf = (i: number) => uniformSize || buf.readUInt32BE(stsz.start + 12 + i * 4);

  const chunkCount = buf.readUInt32BE((stco ?? co64)!.start + 4);
  const chunkOffset = (i: number) =>
    stco ? buf.readUInt32BE(stco.start + 8 + i * 4) : Number(buf.readBigUInt64BE(co64!.start + 8 + i * 8));

  // stsc runs: from first_chunk (1-based) on, each chunk holds samples_per_chunk samples.
  const runCount = buf.readUInt32BE(stsc.start + 4);
  const run = (i: number) => ({
    firstChunk: buf.readUInt32BE(stsc.start + 8 + i * 12),
    perChunk: buf.readUInt32BE(stsc.start + 12 + i * 12),
  });

  const wanted = Math.min(sampleCount, Math.ceil((seconds + marginSeconds) / frameSeconds));
  const parts: Buffer[] = [];
  let sample = 0;
  let runIndex = 0;
  for (let chunk = 0; chunk < chunkCount && sample < wanted; chunk++) {
    while (runIndex + 1 < runCount && run(runIndex + 1).firstChunk <= chunk + 1) runIndex++;
    let at = chunkOffset(chunk);
    for (let i = 0; i < run(runIndex).perChunk && sample < wanted; i++, sample++) {
      const size = sizeOf(sample);
      if (at + size > buf.length) throw new Error("MP4 sample data is truncated");
      parts.push(adtsHeader(config, size), buf.subarray(at, at + size));
      at += size;
    }
  }
  if (sample === 0) throw new Error("No AAC frames found");
  return { aac: Buffer.concat(parts), seconds: sample * frameSeconds };
}
