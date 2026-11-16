/**
 * Adds an artist's whole catalogue from a mock iTunes into a real Postgres.
 * Needs DATABASE_URL; skipped otherwise. It only touches rows it creates.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { songKey } from "@splitsecond/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CatalogService } from "../catalog/catalog.service";
import { GameService } from "../game/game.service";
import { ItunesClient } from "../itunes/itunes-client";
import { MockItunesSong, startMockApple } from "../../test/fixtures";
import { RULES_VERSION, artistIdFromLine, parseArtistsFile, seedArtists } from "./artist-seeder";

const ID = 950_000_000;
const NOVA = 9501;
const ECHO = 9502;
const m4a = readFileSync(join(__dirname, "../../test/data/tone-fast.m4a"));

const nova = (n: number, title: string, album: [number, string], year: number, extra: Partial<MockItunesSong> = {}): MockItunesSong => ({
  id: ID + n,
  title,
  artist: "Nova Lane",
  artistId: NOVA,
  albumId: album[0],
  albumName: album[1],
  releaseDate: `${year}-03-01T08:00:00Z`,
  durationMs: 200_000,
  genre: "Pop",
  ...extra,
});
const FIRST: [number, string] = [ID + 901, "First Light"];
const RERECORDED: [number, string] = [ID + 902, "First Light (Nova's Version)"];
const LIVE: [number, string] = [ID + 903, "Live in Town"];
const SINGLE: [number, string] = [ID + 904, "Open Road - Single"];
const NEW_SINGLE: [number, string] = [ID + 905, "Brand New - Single"];
const REMIXES: [number, string] = [ID + 907, "Open Road (Remixes) - EP"];

// In the order Apple's search would list them: best known first.
const songs: MockItunesSong[] = [
  // The re-recorded album is the biggest, so it is read first.
  nova(1, "Open Road (Nova's Version)", RERECORDED, 2021),
  nova(2, "Glass Hearts (Nova's Version)", RERECORDED, 2021),
  nova(3, "Vault Song", RERECORDED, 2021),
  nova(4, "Open Road (Karaoke Version)", RERECORDED, 2021),
  nova(5, "Voice Memo: Writing Open Road", RERECORDED, 2021),
  nova(17, "Vault Song (Club Mix)", RERECORDED, 2021),
  nova(18, "Vault Song (Acoustic)", RERECORDED, 2021),
  // The original album.
  nova(6, "Open Road", FIRST, 2010),
  nova(7, "Glass Hearts", FIRST, 2010),
  nova(8, "Interlude", FIRST, 2010, { durationMs: 31_000 }),
  nova(9, "Duet", FIRST, 2010, { artist: "Nova Lane & Echo Park" }),
  nova(10, "Guest Track", FIRST, 2010, { artist: "Someone Else" }),
  nova(19, "Vault Song", FIRST, 2010, { artist: "Nova Lane & Echo Park" }), // a duet version of a solo song
  // A live album, including a song that exists nowhere else.
  nova(11, "Glass Hearts (Live)", LIVE, 2012),
  nova(12, "Only Ever Live (Live)", LIVE, 2012),
  nova(13, "No Preview Here", LIVE, 2012, { preview: false }),
  // Singles: one of an album track, one that is on no album.
  nova(14, "Open Road", SINGLE, 2010),
  nova(15, "Brand New", NEW_SINGLE, 2024),
  // A remix EP.
  nova(20, "Open Road (DJ Example Remix)", REMIXES, 2011),
  nova(21, "Open Road (Extended Mix)", REMIXES, 2011),
];

describe("the artists file", () => {
  it("reads one artist per line, ignoring comments, blanks and repeats", () => {
    const text = "# my artists\n\nNova Lane\n  Echo Park  # the band\r\nnova lane\n#Hidden One\nAC/DC\n";
    expect(parseArtistsFile(text)).toEqual(["Nova Lane", "Echo Park", "AC/DC"]);
  });

  it("recognises an Apple id or Apple Music link", () => {
    expect(artistIdFromLine("159260351")).toBe("159260351");
    expect(artistIdFromLine("https://music.apple.com/us/artist/taylor-swift/159260351")).toBe("159260351");
    expect(artistIdFromLine("https://music.apple.com/in/artist/159260351?l=en")).toBe("159260351");
    expect(artistIdFromLine("https://itunes.apple.com/us/artist/taylor-swift/id159260351")).toBe("159260351");
    expect(artistIdFromLine("Taylor Swift")).toBeNull();
    expect(artistIdFromLine("blink-182")).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("artist catalogues", () => {
  let prisma: PrismaService;
  let mock: Awaited<ReturnType<typeof startMockApple>>;
  let itunes: ItunesClient;
  let previousPool: string[] = [];
  const runIds: string[] = [];
  const mine = { itunesId: { gte: BigInt(ID), lt: BigInt(ID + 1000) } };
  const log: string[] = [];
  const seed = (lines: string[]) => seedArtists(prisma, itunes, lines, { log: (m) => log.push(m) });
  const catalogue = async () =>
    (
      await prisma.track.findMany({
        where: { sources: { some: { kind: "artist", reference: String(NOVA) } } },
        orderBy: { title: "asc" },
      })
    ).map((t) => ({ title: t.title, id: Number(t.itunesId) - ID, year: t.year, deep: t.catalogOnly, rank: t.rank }));

  beforeAll(async () => {
    mock = await startMockApple(songs, m4a, {
      artists: [
        { id: NOVA, name: "Nova Lane" },
        { id: ECHO, name: "Echo Park" },
        { id: 9503, name: "Nova Lane Tribute Band" },
      ],
      appearsOn: { [NOVA]: [{ id: ID + 950, name: "Now That's What I Call a Compilation", artistId: 1 }] },
    });
    itunes = new ItunesClient({ baseUrl: mock.url, perMinute: 60_000, backoffMs: 1, attempts: 2 });
    process.env.ITUNES_API_BASE = mock.url;
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.track.deleteMany({ where: mine });
    await prisma.artistImport.deleteMany({ where: { itunesId: { in: [BigInt(NOVA), BigInt(ECHO)] } } });
    const existing = await prisma.track.findMany({ where: { inPool: true }, select: { id: true } });
    previousPool = existing.map((t) => t.id);
    await prisma.track.updateMany({ where: { id: { in: previousPool } }, data: { inPool: false } });
    // "Glass Hearts" was a chart hit, already in the pool from the Billboard seed.
    await prisma.track.create({
      data: {
        itunesId: BigInt(ID + 7),
        title: "Glass Hearts",
        artist: "Nova Lane",
        rank: 900_000,
        year: 2011,
        songKey: songKey("Glass Hearts", "Nova Lane"),
      },
    });
  });

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { id: { in: runIds } } });
    await prisma.track.deleteMany({ where: mine });
    await prisma.artistImport.deleteMany({ where: { itunesId: { in: [BigInt(NOVA), BigInt(ECHO)] } } });
    await prisma.track.updateMany({ where: { id: { in: previousPool } }, data: { inPool: true } });
    await prisma.$disconnect();
    await mock.close();
  });

  it("adds every original song once, and no live, remix or other versions", async () => {
    const result = await seed(["Nova Lane"]);
    expect(result).toEqual({ artists: 1, added: 4, removed: 0, notFound: [], stopped: false });
    // Three releases read. The live album, the remix EP, the single of an album track
    // and the compilation the artist only appears on are not even fetched.
    expect(mock.stats().albumLookups).toBe(3);

    const all = await catalogue();
    expect(all.map((t) => [t.title, t.id, t.year, t.deep])).toEqual([
      ["Brand New", 15, 2024, true],
      ["Duet", 9, 2010, true],
      ["Glass Hearts", 7, 2011, false], // the chart hit stays a hit, and keeps its year
      ["Open Road", 6, 2010, true], // read first as "(Nova's Version)", then replaced by the original
      ["Vault Song", 3, 2021, true], // the solo recording, not the later-read duet version
    ]);
    // The club mix, the acoustic take, karaoke, the voice memo, the interlude, someone
    // else's track and everything live are left out, even a song that only exists live.
    expect(await prisma.track.count({ where: mine })).toBe(5);

    // Apple's listing order stands in for popularity; the hit keeps its chart rank.
    const rank = Object.fromEntries(all.map((t) => [t.title, t.rank]));
    expect(rank["Open Road"]).toBe(500_000);
    expect(rank["Glass Hearts"]).toBe(900_000);
    expect(rank["Open Road"]).toBeGreaterThan(rank["Vault Song"]);
    expect(rank["Vault Song"]).toBeGreaterThan(rank["Brand New"]);
  });

  it("reads nothing again on the next seed, then only a new release", async () => {
    const before = mock.stats();
    expect(await seed(["nova lane"])).toMatchObject({ artists: 1, added: 0 });
    expect(mock.stats().albumLookups).toBe(before.albumLookups);
    expect(mock.stats().searches).toBe(before.searches); // the artist isn't looked up by name again
    expect(log.at(-1)).toBe("Nova Lane: up to date, 5 songs");

    songs.push(nova(16, "Next Chapter", [ID + 906, "Next Chapter - Single"], 2026));
    expect(await seed(["Nova Lane"])).toMatchObject({ added: 1 });
    expect(mock.stats().albumLookups).toBe(before.albumLookups + 1);
  });

  it("reads an artist again when the rules have changed, clearing out what the old rules let in", async () => {
    const before = await catalogue();
    const rows = await prisma.track.count({ where: mine });
    // As an older version left it: live recordings in the pool, and every album marked as read.
    const old = (n: number, title: string) =>
      prisma.track.create({
        data: {
          itunesId: BigInt(ID + n),
          title,
          artist: "Nova Lane",
          rank: 10_000,
          songKey: songKey(title, "Nova Lane"),
          catalogOnly: true,
          sources: { create: { kind: "artist", reference: String(NOVA) } },
        },
      });
    const stale = await old(12, "Only Ever Live (Live)");
    const played = await old(11, "Glass Hearts (Live)");
    // One of them came up in a run, so the run still points at it.
    const run = await prisma.run.create({ data: { rounds: { create: { index: 0, trackId: played.id } } } });
    runIds.push(run.id);
    // And one left behind, out of the pool, by an earlier clear-out.
    const leftover = await prisma.track.create({
      data: {
        itunesId: BigInt(ID + 21),
        title: "Open Road (Extended Mix)",
        artist: "Nova Lane",
        rank: 10_000,
        songKey: songKey("Open Road (Extended Mix)", "Nova Lane"),
        catalogOnly: true,
        inPool: false,
      },
    });
    await prisma.artistImport.update({ where: { itunesId: BigInt(NOVA) }, data: { rules: RULES_VERSION - 1 } });

    await seed(["Nova Lane"]);
    expect(log.some((m) => m.startsWith("Nova Lane: reading again"))).toBe(true);
    // Gone from the database, not just from the pool.
    expect(await prisma.track.findUnique({ where: { id: stale.id } })).toBeNull();
    expect(await prisma.track.findUnique({ where: { id: leftover.id } })).toBeNull();
    // The one a run points at has to stay, but out of the pool.
    expect(await prisma.track.findUnique({ where: { id: played.id } })).toMatchObject({ inPool: false });
    expect(await catalogue()).toEqual(before);
    expect(await prisma.track.count({ where: mine })).toBe(rows + 1);
    expect(await prisma.artistImport.findUnique({ where: { itunesId: BigInt(NOVA) } })).toMatchObject({ rules: RULES_VERSION });
    // The hit was never taken out of the pool.
    expect(await prisma.track.findFirst({ where: { itunesId: BigInt(ID + 7) } })).toMatchObject({ inPool: true, catalogOnly: false });
  });

  it("takes an Apple Music link, and says so when a name isn't found", async () => {
    const result = await seed([`https://music.apple.com/us/artist/echo-park/${ECHO}`, "Nova"]);
    expect(result).toMatchObject({ artists: 1, added: 0, notFound: ["Nova"] });
    expect(await prisma.artistImport.findUnique({ where: { itunesId: BigInt(ECHO) } })).toMatchObject({ name: "Echo Park" });
    expect(log.some((m) => m.includes('"Nova": no artist with exactly that name') && m.includes("closest: Nova Lane"))).toBe(true);
    // A line that wasn't recognised may be a typo for an artist already in, so nothing is taken out.
    expect(result.removed).toBe(0);
    expect(await prisma.artistImport.count({ where: { itunesId: BigInt(NOVA) } })).toBe(1);
  });

  it("stops cleanly when Apple refuses lookups", async () => {
    await prisma.artistImport.deleteMany({ where: { itunesId: BigInt(ECHO) } });
    mock.control.rejectNext = 2;
    expect(await seed(["Echo Park"])).toMatchObject({ artists: 0, stopped: true });
    expect(mock.control.rejectNext).toBe(0);
  });

  it("plays deep cuts only when their artist is picked", async () => {
    const game = new GameService(prisma, new CatalogService(prisma));
    const options = await game.poolOptions();
    expect(options.artists).toContain("Nova Lane");
    expect(options.songs.filter((s) => s.d)).toHaveLength(5);
    expect(options.songs.filter((s) => !s.d)).toHaveLength(1);

    // With all artists, only the one hit counts, which isn't enough for a run.
    await expect(game.createRun()).rejects.toThrow(/needs at least 5 songs/);
    await expect(game.createRun({ genres: ["Pop"] })).rejects.toThrow(/Only 1 song matches/);

    const run = await game.createRun({ artists: ["Nova Lane"] });
    runIds.push(run.runId);
    const answers = await prisma.round.findMany({ where: { runId: run.runId }, include: { track: true }, orderBy: { index: "asc" } });
    expect(answers.every((r) => r.track.artist.includes("Nova Lane"))).toBe(true);
    // Easy to hard: the hit first.
    expect(answers[0].track.title).toBe("Glass Hearts");
  });

  it("takes an artist's catalogue out again once the artist leaves the file", async () => {
    const played = await prisma.round.findMany({ where: { runId: { in: runIds } }, select: { trackId: true } });
    const result = await seed(["Echo Park"]);
    // Five deep cuts leave; the chart hit is in the pool in its own right.
    expect(result).toMatchObject({ artists: 1, removed: 5, notFound: [] });
    expect(log).toContain("Nova Lane: no longer in artists.txt, 5 songs taken out");
    expect(await prisma.artistImport.count({ where: { itunesId: BigInt(NOVA) } })).toBe(0);
    const left = await prisma.track.findMany({ where: mine });
    expect(left.filter((t) => t.inPool).map((t) => t.title)).toEqual(["Glass Hearts"]);
    // What stays in the database is only what a played run points at.
    const kept = new Set(played.map((r) => r.trackId));
    expect(left.filter((t) => !t.inPool).every((t) => kept.has(t.id))).toBe(true);
    expect(left.filter((t) => !t.inPool).length).toBeGreaterThan(0);

    // Back in the file, the catalogue is read again.
    expect(await seed(["Nova Lane", "Echo Park"])).toMatchObject({ artists: 2, added: 5, removed: 0 });
    expect((await catalogue()).map((t) => t.title)).toEqual(["Brand New", "Duet", "Glass Hearts", "Next Chapter", "Open Road", "Vault Song"]);
  });
});
