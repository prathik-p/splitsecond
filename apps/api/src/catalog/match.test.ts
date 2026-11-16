import { describe, expect, it } from "vitest";
import { findMatches } from "./match";
import type { CatalogTrack } from "./types";

const track = (id: number, title: string, artist: string, rank: number, extra: Partial<CatalogTrack> = {}): CatalogTrack => ({
  id: String(id),
  title,
  artist,
  rank,
  album: "Album",
  coverUrl: null,
  releaseDate: null,
  previewUrl: `https://example.test/${id}.m4a`,
  playable: true,
  ...extra,
});

/** The first match, as the seeders take it. */
const firstMatch = (title: string, artist: string, candidates: CatalogTrack[]) => findMatches(title, artist, candidates)[0] ?? null;

describe("findMatches", () => {
  it("matches across release decorations, in the order given", () => {
    const hits = findMatches("Heroes", "David Bowie", [
      track(1, "Heroes - 2017 Remaster", "David Bowie", 0),
      track(2, "Heroes (Single Version)", "David Bowie", 0),
      track(3, "Heroes", "Some Cover Band", 0),
    ]);
    expect(hits.map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("accepts a collaboration credit but not a different artist", () => {
    expect(firstMatch("Under Pressure", "Queen", [track(1, "Under Pressure", "Queen & David Bowie", 10)])?.id).toBe("1");
    expect(firstMatch("Cherry", "Air", [track(1, "Cherry", "Fairport Convention", 10)])).toBeNull();
  });

  it("rejects acts whose name merely contains the artist", () => {
    expect(firstMatch("Yeah!", "Usher", [track(1, "Yeah!", "Usher Tribute Band", 10)])).toBeNull();
    expect(firstMatch("Yeah!", "Usher", [track(1, "Yeah!", "Karaoke Hits of Usher", 10)])).toBeNull();
  });

  it("matches collaborations however they are credited", () => {
    expect(firstMatch("Over and Over", "Nelly and Tim McGraw", [track(1, "Over and Over", "Nelly", 10)])?.id).toBe("1");
    expect(firstMatch("Song", "Kanye West", [track(1, "Song", "Kanye West, Jay-Z & Big Sean", 10)])?.id).toBe("1");
    expect(firstMatch("Song", "The Black Eyed Peas", [track(1, "Song", "Black Eyed Peas", 10)])?.id).toBe("1");
    expect(firstMatch("Song", "Florence and the Machine", [track(1, "Song", "Florence + The Machine", 10)])?.id).toBe("1");
    expect(firstMatch("Song", "Earth, Wind & Fire", [track(1, "Song", "Earth, Wind & Fire", 10)])?.id).toBe("1");
  });

  it("rejects a different song by the same artist", () => {
    expect(firstMatch("Hello", "Adele", [track(1, "Hello Again", "Adele", 10)])).toBeNull();
  });

  it("skips tracks that can't be played", () => {
    const hit = firstMatch("Song", "Band", [track(1, "Song", "Band", 900, { playable: false, previewUrl: null }), track(3, "Song", "Band", 100)]);
    expect(hit?.id).toBe("3");
  });

  it("keeps Apple's order", () => {
    expect(firstMatch("Song", "Band", [track(9, "Other", "Band", 0), track(7, "Song", "Band", 0), track(8, "Song (Live)", "Band", 0)])?.id).toBe("7");
  });
});
