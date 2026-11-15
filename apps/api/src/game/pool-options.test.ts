import { describe, expect, it } from "vitest";
import { songKey } from "@splitsecond/shared";
import { buildOptions, cleanFilters, matchingKeys, type OptionTrack } from "./pool-options";

const track = (title: string, artist: string, genre: string | null = "Pop"): OptionTrack => ({
  title,
  artist,
  genre,
  songKey: songKey(title, artist),
});

/** Song titles per artist name, as the options would list them. */
function byArtist(tracks: OptionTrack[]) {
  const { options } = buildOptions(tracks);
  const out: Record<string, number> = {};
  for (const song of options.songs) for (const a of song.a) out[options.artists[a]] = (out[options.artists[a]] ?? 0) + 1;
  return out;
}

describe("buildOptions", () => {
  it("lists genres biggest first, renames Apple's long ones and groups the small ones", () => {
    const tracks = [
      ...Array.from({ length: 6 }, (_, i) => track(`Rap ${i}`, `Rapper ${i}`, "Hip-Hop/Rap")),
      ...Array.from({ length: 7 }, (_, i) => track(`Pop ${i}`, `Singer ${i}`, "Pop")),
      ...Array.from({ length: 5 }, (_, i) => track(`Soul ${i}`, `Crooner ${i}`, "R&B/Soul")),
      track("Lone Polka", "Polka Band", "Polka"),
      track("Lone Waltz", "Waltz Band", "Waltz"),
      track("No Genre", "Mystery Act", null),
    ];
    const { options } = buildOptions(tracks);
    expect(options.genres).toEqual(["Pop", "Hip-Hop", "R&B", "Other"]);
    const count = (g: number) => options.songs.filter((s) => s.g === g).length;
    expect([0, 1, 2, 3, -1].map(count)).toEqual([7, 6, 5, 2, 1]);
  });

  it("leaves out Other when no genre is too small", () => {
    const tracks = Array.from({ length: 5 }, (_, i) => track(`Pop ${i}`, `Singer ${i}`, "Pop"));
    expect(buildOptions(tracks).options.genres).toEqual(["Pop"]);
  });

  it("counts a song once per song, not per release", () => {
    const { options } = buildOptions([track("Hit", "Singer"), track("Hit (Remastered)", "Singer"), track("Other Hit", "Singer")]);
    expect(options.songs).toHaveLength(2);
  });

  it("credits collaborations and featured guests to acts with songs of their own", () => {
    const counts = byArtist([
      track("Solo One", "Rihanna"),
      track("Solo Two", "Calvin Harris"),
      track("Together", "Calvin Harris & Rihanna"),
      track("Guest Spot (feat. Rihanna)", "Eminem"),
      track("Lead Known", "Rihanna & Somebody New"),
      track("Lead Unknown", "Somebody Else & Rihanna"),
    ]);
    expect(counts).toEqual({
      Rihanna: 4, // solo, together, guest spot, lead known
      "Calvin Harris": 2,
      Eminem: 1,
      "Somebody Else & Rihanna": 1, // not split: the lead act has nothing else here
    });
  });

  it("keeps a band whose name looks like a list in one piece", () => {
    const counts = byArtist([
      track("September", "Earth, Wind & Fire"),
      track("Burning", "Fire"),
      track("Shake It Out", "Florence + the Machine"),
      track("Earfquake", "Tyler, The Creator"),
    ]);
    expect(counts).toEqual({ "Earth, Wind & Fire": 1, Fire: 1, "Florence + the Machine": 1, "Tyler, The Creator": 1 });
  });
});

describe("matchingKeys", () => {
  const tracks = [
    track("Pop One", "Alpha", "Pop"),
    track("Pop Two", "Beta", "Pop"),
    track("Rock One", "Alpha", "Rock"),
    track("Rock Two (feat. Beta)", "Gamma", "Rock"),
    ...Array.from({ length: 4 }, (_, i) => track(`Pop Filler ${i}`, `Filler ${i}`, "Pop")),
    ...Array.from({ length: 3 }, (_, i) => track(`Rock Filler ${i}`, `Rocker ${i}`, "Rock")),
  ];
  const index = buildOptions(tracks);
  const titles = (genres: string[], artists: string[]) =>
    tracks.filter((t) => matchingKeys(index, { genres, artists }).has(t.songKey)).map((t) => t.title);

  it("treats an empty list as any", () => {
    expect(titles([], [])).toHaveLength(tracks.length);
  });

  it("narrows by genre, by artist, and by both together", () => {
    expect(titles(["Rock"], [])).toHaveLength(5);
    expect(titles([], ["Alpha"])).toEqual(["Pop One", "Rock One"]);
    expect(titles([], ["Alpha", "beta"])).toEqual(["Pop One", "Pop Two", "Rock One", "Rock Two (feat. Beta)"]);
    expect(titles(["Rock"], ["Beta"])).toEqual(["Rock Two (feat. Beta)"]);
    expect(titles(["Pop", "Rock"], ["Gamma"])).toEqual(["Rock Two (feat. Beta)"]);
  });

  it("matches nothing for names it doesn't know", () => {
    expect(titles(["Polka"], [])).toEqual([]);
    expect(titles([], ["Nobody"])).toEqual([]);
  });
});

describe("cleanFilters", () => {
  it("keeps only tidy, distinct names", () => {
    expect(cleanFilters([" Pop ", "Pop", "", 3, null], "Alpha")).toEqual({ genres: ["Pop"], artists: [] });
    expect(cleanFilters(undefined, ["Alpha", "Beta"])).toEqual({ genres: [], artists: ["Alpha", "Beta"] });
  });
});
