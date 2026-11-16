import { describe, expect, it } from "vitest";
import { parseYearEndPage, retryAfterMs } from "./wikipedia-charts";
import { chartIdsFromFeed } from "./apple-chart";
import { chooseForEntry, leadArtist, rankForPosition } from "./billboard-seeder";
import type { CatalogTrack } from "../catalog/types";
import { yearEndHtml } from "../../test/fixtures";

describe("parseYearEndPage", () => {
  it("reads position, title and artist, dropping quotes, links and footnotes", () => {
    const html = yearEndHtml([
      { position: 1, title: "We Belong Together", artist: "Mariah Carey" },
      { position: 2, title: "Hollaback Girl", artist: "Gwen Stefani" },
    ]);
    expect(parseYearEndPage(html)).toEqual([
      { position: 1, title: "We Belong Together", artist: "Mariah Carey" },
      { position: 2, title: "Hollaback Girl", artist: "Gwen Stefani" },
    ]);
  });

  it("handles td position cells, entities, double A-sides and an artist spanning rows", () => {
    const html = `
      <table class="infobox"><tr><td>1</td><td>not</td><td>the chart</td></tr></table>
      <table class="wikitable">
        <tr><th>№</th><th>Title</th><th>Artist(s)</th></tr>
        <tr><td>1</td><td>"<a>Don&#39;t Cha</a>"</td><td rowspan="2"><a>The Pussycat Dolls</a> featuring <a>Busta Rhymes</a></td></tr>
        <tr><td>2</td><td>"<a>Stickwitu</a>"</td></tr>
        <tr><td>3</td><td>"<a>Rock &amp; Roll</a>" / "<a>B-Side</a>"</td><td>Tom &amp; Jerry</td></tr>
        <tr><td>4</td><td>“<a>Curly Quotes</a>”<sup><a>[2]</a></sup></td><td>Someone</td></tr>
      </table>`;
    expect(parseYearEndPage(html)).toEqual([
      { position: 1, title: "Don't Cha", artist: "The Pussycat Dolls featuring Busta Rhymes" },
      { position: 2, title: "Stickwitu", artist: "The Pussycat Dolls featuring Busta Rhymes" },
      { position: 3, title: "Rock & Roll", artist: "Tom & Jerry" },
      { position: 4, title: "Curly Quotes", artist: "Someone" },
    ]);
  });

  it("returns nothing for a page without a chart", () => {
    expect(parseYearEndPage("<p>No tables here</p>")).toEqual([]);
  });
});

describe("matching chart entries to the catalog", () => {
  const song = (id: string, title: string, artist: string, releaseDate: string | null = null): CatalogTrack => ({
    provider: "itunes", id, title, artist, album: null, coverUrl: null, rank: 0, isrc: null,
    releaseDate, previewUrl: "https://example.test/p.m4a", playable: true,
  });

  it("searches by the lead artist", () => {
    expect(leadArtist("Usher featuring Lil Jon and Ludacris")).toBe("Usher");
    expect(leadArtist("Macklemore & Ryan Lewis")).toBe("Macklemore");
    expect(leadArtist("Lil Nas X featuring Billy Ray Cyrus")).toBe("Lil Nas X");
    expect(leadArtist("Adele")).toBe("Adele");
  });

  it("accepts featured-artist and duo credits", () => {
    const entry = { position: 1, title: "Yeah!", artist: "Usher featuring Lil Jon and Ludacris" };
    expect(chooseForEntry(entry, 2004, [song("1", "Yeah! (feat. Lil Jon & Ludacris)", "USHER")])?.id).toBe("1");
    const duo = { position: 2, title: "Thrift Shop", artist: "Macklemore & Ryan Lewis featuring Wanz" };
    expect(chooseForEntry(duo, 2013, [song("2", "Thrift Shop (feat. Wanz)", "Macklemore & Ryan Lewis")])?.id).toBe("2");
    const pair = { position: 3, title: "Over and Over", artist: "Nelly and Tim McGraw" };
    expect(chooseForEntry(pair, 2005, [song("3", "Over and Over (feat. Tim McGraw)", "Nelly")])?.id).toBe("3");
  });

  it("accepts stylised artist names but not other artists", () => {
    const entry = { position: 1, title: "So What", artist: "Pink" };
    expect(chooseForEntry(entry, 2008, [song("1", "So What", "P!nk")])?.id).toBe("1");
    expect(chooseForEntry({ position: 1, title: "Tik Tok", artist: "Kesha" }, 2010, [song("2", "TiK ToK", "Ke$ha")])?.id).toBe("2");
    expect(chooseForEntry(entry, 2008, [song("3", "So What", "Karaoke Hits Band")])).toBeNull();
    expect(chooseForEntry(entry, 2008, [song("4", "So What", "Miles Davis")])).toBeNull();
  });

  it("prefers the release from around the chart year", () => {
    const entry = { position: 1, title: "Love Story", artist: "Taylor Swift" };
    const picked = chooseForEntry(entry, 2009, [
      song("1", "Love Story (Taylor's Version)", "Taylor Swift", "2021-02-12T08:00:00Z"),
      song("2", "Love Story", "Taylor Swift", "2008-09-12T07:00:00Z"),
    ]);
    expect(picked?.id).toBe("2");
    // If only a later release exists, the song is still kept.
    expect(chooseForEntry(entry, 2009, [song("1", "Love Story", "Taylor Swift", "2021-02-12T08:00:00Z")])?.id).toBe("1");
  });

  it("never picks a live or livestream version, by title or by album", () => {
    const entry = { position: 1, title: "Stressed Out", artist: "Twenty One Pilots" };
    const onAlbum = (id: string, album: string, releaseDate: string) => ({ ...song(id, "Stressed Out", "twenty one pilots", releaseDate), album });
    const livestream = onAlbum("1", "Scaled And Icy (Livestream Version)", "2021-05-21T07:00:00Z");
    const live = { ...song("2", "Stressed Out (Live)", "twenty one pilots", "2016-05-21T07:00:00Z"), album: "Blurryface" };
    const studio = onAlbum("3", "Blurryface", "2015-05-15T07:00:00Z");
    expect(chooseForEntry(entry, 2016, [livestream, live, studio])?.id).toBe("3");
    // Only another version on the catalog: better no song than the wrong recording.
    expect(chooseForEntry(entry, 2016, [livestream, live])).toBeNull();
  });

  it("ranks the top of the chart as the easiest", () => {
    expect(rankForPosition(1)).toBe(1_000_000);
    expect(rankForPosition(100)).toBe(10_000);
    expect(rankForPosition(1)).toBeGreaterThan(rankForPosition(2));
  });
});

describe("retryAfterMs", () => {
  it("reads seconds or a date, and nothing from junk", () => {
    expect(retryAfterMs("12")).toBe(12_000);
    expect(retryAfterMs("Fri, 13 Nov 2026 10:00:30 GMT", Date.parse("2026-11-13T10:00:00Z"))).toBe(30_000);
    expect(retryAfterMs("Fri, 13 Nov 2026 10:00:30 GMT", Date.parse("2026-11-13T11:00:00Z"))).toBe(0);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs("soon")).toBeNull();
  });
});

describe("chartIdsFromFeed", () => {
  it("reads both shapes of Apple feed", () => {
    expect(chartIdsFromFeed({ feed: { results: [{ id: "11" }, { id: "x" }, {}, { id: "12" }] } })).toEqual(["11", "12"]);
    const entry = (id: string) => ({ id: { attributes: { "im:id": id } } });
    expect(chartIdsFromFeed({ feed: { entry: [entry("21"), entry("22")] } })).toEqual(["21", "22"]);
    expect(chartIdsFromFeed({ feed: { entry: entry("31") } })).toEqual(["31"]);
    expect(chartIdsFromFeed({})).toEqual([]);
  });
});
