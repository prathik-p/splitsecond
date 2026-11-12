import { describe, expect, it } from "vitest";
import { parseFrameHeader, sliceMp3 } from "./mp3";
import { FRAME_BYTES, FRAME_SECONDS, fakeMp3 } from "../../test/fixtures";

describe("parseFrameHeader", () => {
  it("reads an MPEG-1 Layer III header", () => {
    expect(parseFrameHeader(fakeMp3(1), 0)).toEqual({ length: FRAME_BYTES, samples: 1152, sampleRate: 44100 });
  });

  it("rejects garbage", () => {
    expect(parseFrameHeader(Buffer.from([0x00, 0x11, 0x22, 0x33]), 0)).toBeNull();
  });
});

describe("sliceMp3", () => {
  const full = fakeMp3(1200); // ~31 s

  it("returns only enough frames to cover the unlocked time", () => {
    const { mp3, seconds } = sliceMp3(full, 0.1, 0);
    expect(mp3.length).toBe(4 * FRAME_BYTES); // 4 × 26 ms ≥ 100 ms
    expect(seconds).toBeGreaterThanOrEqual(0.1);
    expect(seconds).toBeLessThan(0.1 + FRAME_SECONDS);
  });

  it("grows with the unlocked time and never exceeds the file", () => {
    expect(sliceMp3(full, 1).mp3.length).toBeLessThan(sliceMp3(full, 5).mp3.length);
    expect(sliceMp3(full, 999).mp3.length).toBe(full.length);
  });

  it("skips ID3 tags and the Xing/Info frame", () => {
    const { mp3 } = sliceMp3(fakeMp3(100, { id3: true, xing: true }), 0.1, 0);
    expect(mp3.length).toBe(4 * FRAME_BYTES);
    expect(mp3[0]).toBe(0xff);
    expect(mp3.toString("latin1").includes("Info")).toBe(false);
    expect(mp3.toString("latin1").includes("ID3")).toBe(false);
  });

  it("throws on data with no frames", () => {
    expect(() => sliceMp3(Buffer.alloc(2000), 1)).toThrow();
  });
});
