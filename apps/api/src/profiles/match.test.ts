import { describe, expect, it } from "vitest";
import { pickMatch } from "./match";
import type { DeezerTrack } from "../deezer/deezer-client";
import { fromDeezer } from "../deezer/deezer-catalog";
import type { CatalogTrack } from "../catalog/types";

const track = (id: number, title: string, artist: string, rank: number, extra: Partial<DeezerTrack> = {}): CatalogTrack =>
  fromDeezer({
    id,
    title,
    rank,
    duration: 200,
    preview: `https://example.test/${id}.mp3`,
    artist: { id: 1, name: artist },
    album: { id: 1, title: "Album" },
    ...extra,
  } as DeezerTrack);

describe("pickMatch", () => {
  it("matches across release decorations and picks the most popular release", () => {
    const hit = pickMatch("Heroes", "David Bowie", [
      track(1, "Heroes - 2017 Remaster", "David Bowie", 500),
      track(2, "Heroes (Single Version)", "David Bowie", 900),
      track(3, "Heroes", "Some Cover Band", 999),
    ]);
    expect(hit?.id).toBe("2");
  });

  it("accepts a collaboration credit but not a different artist", () => {
    expect(pickMatch("Under Pressure", "Queen", [track(1, "Under Pressure", "Queen & David Bowie", 10)])?.id).toBe("1");
    expect(pickMatch("Cherry", "Air", [track(1, "Cherry", "Fairport Convention", 10)])).toBeNull();
  });

  it("rejects acts whose name merely contains the artist", () => {
    expect(pickMatch("Yeah!", "Usher", [track(1, "Yeah!", "Usher Tribute Band", 10)])).toBeNull();
    expect(pickMatch("Yeah!", "Usher", [track(1, "Yeah!", "Karaoke Hits of Usher", 10)])).toBeNull();
  });

  it("matches collaborations however they are credited", () => {
    expect(pickMatch("Over and Over", "Nelly and Tim McGraw", [track(1, "Over and Over", "Nelly", 10)])?.id).toBe("1");
    expect(pickMatch("Song", "Kanye West", [track(1, "Song", "Kanye West, Jay-Z & Big Sean", 10)])?.id).toBe("1");
    expect(pickMatch("Song", "The Black Eyed Peas", [track(1, "Song", "Black Eyed Peas", 10)])?.id).toBe("1");
    expect(pickMatch("Song", "Florence and the Machine", [track(1, "Song", "Florence + The Machine", 10)])?.id).toBe("1");
    expect(pickMatch("Song", "Earth, Wind & Fire", [track(1, "Song", "Earth, Wind & Fire", 10)])?.id).toBe("1");
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
    expect(hit?.id).toBe("3");
  });

  it("keeps the first match when popularity is unknown, as on iTunes", () => {
    const itunes = (id: string, title: string): CatalogTrack => ({
      provider: "itunes", id, title, artist: "Band", album: null, coverUrl: null, rank: 0,
      isrc: null, releaseDate: null, previewUrl: "https://example.test/p.m4a", playable: true,
    });
    expect(pickMatch("Song", "Band", [itunes("9", "Other"), itunes("7", "Song"), itunes("8", "Song (Live)")])?.id).toBe("7");
  });

  it("uses title_short when the full title carries a version", () => {
    expect(pickMatch("Song", "Band", [track(1, "Song (Zebra Version)", "Band", 1, { title_short: "Song" })])?.id).toBe("1");
  });
});
