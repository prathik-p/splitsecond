import { describe, expect, it } from "vitest";
import { pickMatch } from "./match";
import type { DeezerTrack } from "../deezer/deezer-client";

const track = (id: number, title: string, artist: string, rank: number, extra: Partial<DeezerTrack> = {}) =>
  ({
    id,
    title,
    rank,
    duration: 200,
    preview: `https://example.test/${id}.mp3`,
    artist: { id: 1, name: artist },
    album: { id: 1, title: "Album" },
    ...extra,
  }) as DeezerTrack;

describe("pickMatch", () => {
  it("matches across release decorations and picks the most popular release", () => {
    const hit = pickMatch("Heroes", "David Bowie", [
      track(1, "Heroes - 2017 Remaster", "David Bowie", 500),
      track(2, "Heroes (Single Version)", "David Bowie", 900),
      track(3, "Heroes", "Some Cover Band", 999),
    ]);
    expect(hit?.id).toBe(2);
  });

  it("accepts a collaboration credit but not a different artist", () => {
    expect(pickMatch("Under Pressure", "Queen", [track(1, "Under Pressure", "Queen & David Bowie", 10)])?.id).toBe(1);
    expect(pickMatch("Cherry", "Air", [track(1, "Cherry", "Fairport Convention", 10)])).toBeNull();
  });

  it("rejects a different song by the same artist", () => {
    expect(pickMatch("Hello", "Adele", [track(1, "Hello Again", "Adele", 10)])).toBeNull();
  });

  it("skips tracks that can't be played", () => {
    const hit = pickMatch("Song", "Band", [
      track(1, "Song", "Band", 900, { preview: "" }),
      track(2, "Song", "Band", 800, { readable: false }),
      track(3, "Song", "Band", 100),
    ]);
    expect(hit?.id).toBe(3);
  });

  it("uses title_short when the full title carries a version", () => {
    expect(pickMatch("Song", "Band", [track(1, "Song (Zebra Version)", "Band", 1, { title_short: "Song" })])?.id).toBe(1);
  });
});
