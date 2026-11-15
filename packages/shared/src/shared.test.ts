import { describe, expect, it } from "vitest";
import {
  LENGTH_STOPS,
  basePoints,
  nextStop,
  normalizeTitle,
  positionToSeconds,
  scoreRound,
  secondsToPosition,
  snapSeconds,
  songKey,
} from "./index";

describe("scoring", () => {
  it("gives 10,000 at 0.1s and about 3,400 at 30s", () => {
    expect(basePoints(0.1)).toBe(10_000);
    expect(basePoints(30)).toBe(Math.round(10_000 * Math.pow(0.1 / 30, 0.19)));
    expect(basePoints(30)).toBeGreaterThan(3_300);
    expect(basePoints(30)).toBeLessThan(3_500);
  });

  it("decays monotonically", () => {
    expect(basePoints(0.5)).toBeLessThan(basePoints(0.1));
    expect(basePoints(5)).toBeLessThan(basePoints(1));
  });

  it("takes 500 per wrong guess and never goes negative", () => {
    expect(scoreRound(0.1, 2)).toBe(9_000);
    expect(scoreRound(30, 50)).toBe(0);
  });
});

describe("log scrubber", () => {
  it("spends the same width on 0.1→1s as on 3→30s", () => {
    const a = secondsToPosition(1) - secondsToPosition(0.1);
    const b = secondsToPosition(30) - secondsToPosition(3);
    expect(a).toBeCloseTo(b, 10);
  });

  it("round-trips", () => {
    expect(positionToSeconds(0)).toBeCloseTo(0.1);
    expect(positionToSeconds(1)).toBeCloseTo(30);
    expect(positionToSeconds(secondsToPosition(4.2))).toBeCloseTo(4.2);
  });

  it("snaps to tidy values", () => {
    expect(snapSeconds(0.2871)).toBe(0.3);
    expect(snapSeconds(1.9)).toBe(2);
    expect(snapSeconds(7.3)).toBe(7.5);
    expect(snapSeconds(12.4)).toBe(12);
    expect(snapSeconds(99)).toBe(30);
    expect(snapSeconds(0.01)).toBe(0.1);
  });
});

describe("skip steps", () => {
  it("steps through the marked lengths and stops at the full clip", () => {
    const steps: number[] = [];
    for (let s: number | null = 0.1; s !== null; s = nextStop(s)) steps.push(s);
    expect(steps).toEqual([...LENGTH_STOPS]);
    expect(nextStop(30)).toBeNull();
  });

  it("goes to the next mark from a length in between", () => {
    expect(nextStop(0.3)).toBe(0.5);
    expect(nextStop(2.75)).toBe(4);
    expect(nextStop(15)).toBe(30);
  });
});

describe("normalizeTitle", () => {
  it("strips release decorations", () => {
    expect(normalizeTitle("Here Comes the Sun - Remastered 2009")).toBe("here comes the sun");
    expect(normalizeTitle("Señorita (feat. Someone)")).toBe("senorita");
    expect(normalizeTitle("Song [Radio Edit]")).toBe("song");
    expect(normalizeTitle("Track ft. Other Person")).toBe("track");
  });

  it("keeps brackets that are part of the title", () => {
    expect(normalizeTitle("(I Can't Get No) Satisfaction")).toBe("i can t get no satisfaction");
  });

  it("matches the same song across releases", () => {
    expect(songKey("Hello - Live", "Adele")).toBe(songKey("Hello", "adele"));
  });
});
