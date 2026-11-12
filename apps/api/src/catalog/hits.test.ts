import { describe, expect, it } from "vitest";
import { isPlaylistForYear, rankCandidates, releaseFitsYear } from "./hits";
import type { DeezerTrack } from "../deezer/deezer-client";

const t = (id: number, title: string, artist: string, rank: number, extra: Partial<DeezerTrack> = {}) =>
  ({ id, title, rank, duration: 200, preview: "https://example.test/p.mp3", artist: { id: 1, name: artist }, album: { id: 1, title: "A" }, ...extra }) as DeezerTrack;

describe("isPlaylistForYear", () => {
  const p = (title: string, nb_tracks = 50) => ({ title, nb_tracks });

  it("accepts playlists about exactly that year", () => {
    expect(isPlaylistForYear(p("Top Hits 2005"), 2005)).toBe(true);
    expect(isPlaylistForYear(p("2005 - Best Of"), 2005)).toBe(true);
    expect(isPlaylistForYear(p("HITS2005!"), 2005)).toBe(true);
  });

  it("rejects other years, ranges, decades and tiny playlists", () => {
    expect(isPlaylistForYear(p("Top Hits 2006"), 2005)).toBe(false);
    expect(isPlaylistForYear(p("Hits 2000-2010"), 2000)).toBe(false);
    expect(isPlaylistForYear(p("2005 vs 2015"), 2005)).toBe(false);
    expect(isPlaylistForYear(p("2000s Hits"), 2000)).toBe(false);
    expect(isPlaylistForYear(p("2000's Throwbacks"), 2000)).toBe(false);
    expect(isPlaylistForYear(p("Hits 2005", 8), 2005)).toBe(false);
    expect(isPlaylistForYear(p("Party Hits"), 2005)).toBe(false);
    expect(isPlaylistForYear(p("Top 120051 songs"), 2005)).toBe(false);
  });
});

describe("rankCandidates", () => {
  it("ranks by how many playlists agree, then by popularity", () => {
    const ranked = rankCandidates(
      new Map([
        [
          2005,
          [
            [t(1, "Big Hit", "A", 100), t(2, "One Vote Wonder", "B", 999), t(3, "Also Big", "C", 500)],
            [t(1, "Big Hit", "A", 100), t(3, "Also Big", "C", 500)],
          ],
        ],
      ]),
    );
    expect(ranked.get(2005)!.map((c) => [c.track.title, c.votes])).toEqual([
      ["Also Big", 2],
      ["Big Hit", 2],
      ["One Vote Wonder", 1],
    ]);
  });

  it("counts a song once per playlist and keeps its most popular release", () => {
    const ranked = rankCandidates(
      new Map([[2005, [[t(1, "Song", "A", 100), t(2, "Song - Remastered", "A", 700), t(3, "Song (Live)", "A", 50)]]]]),
    );
    const [only] = ranked.get(2005)!;
    expect(only.votes).toBe(1);
    expect(only.track.id).toBe(2);
  });

  it("gives a song listed under several years to the year with the most votes, earliest on a tie", () => {
    const song = t(1, "Evergreen", "A", 100);
    const ranked = rankCandidates(
      new Map([
        [2004, [[song]]],
        [2005, [[song], [song]]],
        [2006, [[song], [song]]],
      ]),
    );
    expect(ranked.get(2004)).toHaveLength(0);
    expect(ranked.get(2005)!.map((c) => c.track.title)).toEqual(["Evergreen"]);
    expect(ranked.get(2006)).toHaveLength(0);
  });

  it("skips tracks that can't be played", () => {
    const ranked = rankCandidates(
      new Map([[2005, [[t(1, "No Preview", "A", 1, { preview: "" }), t(2, "Blocked", "B", 1, { readable: false })]]]]),
    );
    expect(ranked.get(2005)).toHaveLength(0);
  });
});

describe("releaseFitsYear", () => {
  it("allows a release up to two years before or one year after", () => {
    expect(releaseFitsYear("2004-11-02", 2005)).toBe(true);
    expect(releaseFitsYear("2003-01-01", 2005)).toBe(true);
    expect(releaseFitsYear("2006-03-01", 2005)).toBe(true);
    expect(releaseFitsYear("1998-05-05", 2005)).toBe(false);
    expect(releaseFitsYear("2019-05-05", 2005)).toBe(false);
  });

  it("gives missing dates the benefit of the doubt", () => {
    expect(releaseFitsYear(undefined, 2005)).toBe(true);
    expect(releaseFitsYear("0000-00-00", 2005)).toBe(true);
  });
});
