import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sliceM4a } from "./m4a";

// 3s of 44.1 kHz stereo AAC-LC made with ffmpeg: once with moov before mdat, once after.
const files = {
  "moov first": readFileSync(join(__dirname, "../../test/data/tone-fast.m4a")),
  "moov last": readFileSync(join(__dirname, "../../test/data/tone-slow.m4a")),
};
const FRAME = 1024 / 44100;

/** Walk an ADTS stream and return its frame lengths, checking every header. */
function adtsFrames(aac: Buffer): number[] {
  const lengths: number[] = [];
  let at = 0;
  while (at < aac.length) {
    expect(aac[at]).toBe(0xff);
    expect(aac[at + 1]).toBe(0xf1);
    expect((aac[at + 2] >> 6) + 1).toBe(2); // AAC-LC
    expect((aac[at + 2] >> 2) & 0x0f).toBe(4); // 44.1 kHz
    expect(((aac[at + 2] & 1) << 2) | (aac[at + 3] >> 6)).toBe(2); // stereo
    const length = ((aac[at + 3] & 0x03) << 11) | (aac[at + 4] << 3) | (aac[at + 5] >> 5);
    expect(length).toBeGreaterThan(7);
    lengths.push(length);
    at += length;
  }
  expect(at).toBe(aac.length);
  return lengths;
}

describe.each(Object.entries(files))("sliceM4a (%s)", (_name, file) => {
  it("returns only enough frames to cover the unlocked time", () => {
    const { aac, seconds } = sliceM4a(file, 0.1, 0);
    const frames = adtsFrames(aac);
    expect(frames).toHaveLength(Math.ceil(0.1 / FRAME)); // 5 frames ≈ 116 ms
    expect(seconds).toBeGreaterThanOrEqual(0.1);
    expect(seconds).toBeLessThan(0.1 + FRAME);
    expect(aac.length).toBeLessThan(file.length / 10);
  });

  it("grows with the unlocked time and stops at the end of the file", () => {
    const one = sliceM4a(file, 1);
    const two = sliceM4a(file, 2);
    expect(two.aac.length).toBeGreaterThan(one.aac.length);
    expect(two.aac.subarray(0, one.aac.length).equals(one.aac)).toBe(true);

    const all = sliceM4a(file, Infinity);
    expect(sliceM4a(file, 999).aac.equals(all.aac)).toBe(true);
    expect(all.seconds).toBeGreaterThan(2.9);
    expect(all.seconds).toBeLessThan(3.2);
    adtsFrames(all.aac);
  });
});

describe("sliceM4a", () => {
  it("gives the same audio wherever moov sits", () => {
    expect(sliceM4a(files["moov first"], 1).aac.equals(sliceM4a(files["moov last"], 1).aac)).toBe(true);
  });

  it("rejects data that isn't an MP4", () => {
    expect(() => sliceM4a(Buffer.alloc(500), 1)).toThrow(/moov/);
    expect(() => sliceM4a(Buffer.from("ID3 not an mp4 at all"), 1)).toThrow();
  });
});
