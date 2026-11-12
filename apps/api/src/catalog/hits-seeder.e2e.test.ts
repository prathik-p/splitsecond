/**
 * Seeds hits by year against a real Postgres and a mock Deezer.
 * Needs DATABASE_URL; skipped otherwise. It only touches rows it creates.
 */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { DeezerClient } from "../deezer/deezer-client";
import { seedHits } from "./hits-seeder";
import { fakeMp3, MockPlaylist, MockTrack, startMockDeezer } from "../../test/fixtures";

const ID = 970_000_000;
const song = (n: number, title: string, rank: number, releaseDate: string, isrc = `HITS${String(n).padStart(8, "0")}`) =>
  ({ id: ID + n, title, artist: `Hit Artist ${n}`, rank, isrc, releaseDate, chart: false }) satisfies MockTrack;

const tracks: MockTrack[] = [
  song(1, "Agreed Hit", 500, "2005-02-01"),
  song(2, "Second Hit", 400, "2004-10-01"),
  song(3, "Lone Popular Pick", 900, "2005-06-01"),
  song(4, "Oldie That Drifted In", 950, "1984-01-01"),
  song(5, "Later Remaster", 940, "2019-01-01"),
  song(6, "Third Hit", 300, "2005-03-01"),
  song(10, "Hit Of 2006", 800, "2006-04-01"),
  song(11, "Another 2006", 700, "2006-05-01"),
  // Same recording as song 10 under another Deezer id.
  { ...song(12, "Hit Of 2006 (Single Version)", 100, "2006-04-01", "HITS00000010"), artist: "Hit Artist 10 & Friend" },
];

const playlists: MockPlaylist[] = [
  { id: 1, title: "Top Hits 2005", trackIds: [1, 2, 3, 4, 5].map((n) => ID + n), nbTracks: 40 },
  { id: 2, title: "Best of 2005", trackIds: [1, 2, 6, 4, 5].map((n) => ID + n), nbTracks: 40 },
  { id: 3, title: "2000s Hits 2005 2006", trackIds: [ID + 10], nbTracks: 40 }, // two years: ignored
  { id: 4, title: "Hits 2005 mini", trackIds: [ID + 11], nbTracks: 5 }, // too small: ignored
  { id: 5, title: "Hits 2006", trackIds: [10, 11, 12, 1].map((n) => ID + n), nbTracks: 40 },
];

describe.skipIf(!process.env.DATABASE_URL)("seedHits", () => {
  const prisma = new PrismaClient();
  let mock: Awaited<ReturnType<typeof startMockDeezer>>;
  let deezer: DeezerClient;
  const mine = { deezerId: { gte: BigInt(ID), lt: BigInt(ID + 100) } };

  beforeAll(async () => {
    mock = await startMockDeezer(tracks, fakeMp3(10), playlists);
    deezer = new DeezerClient(mock.url);
    await prisma.track.deleteMany({ where: mine });
  });

  afterAll(async () => {
    await prisma.track.deleteMany({ where: mine });
    await prisma.$disconnect();
    await mock.close();
  });

  const titles = async (year: number) =>
    (await prisma.track.findMany({ where: { ...mine, year }, orderBy: { title: "asc" } })).map((t) => t.title);

  it("saves each year's hits, tagged with the year and in the default pool", async () => {
    const log: string[] = [];
    const result = await seedHits(prisma, deezer, { fromYear: 2005, toYear: 2006, perYear: 3, log: (m) => log.push(m) });

    // Two playlists agree on Agreed Hit and Second Hit; the third slot goes to the
    // most popular single pick whose release date fits. The oldie and the remaster don't.
    expect(await titles(2005)).toEqual(["Agreed Hit", "Lone Popular Pick", "Second Hit"]);
    // Agreed Hit also sits in the 2006 playlist but belongs to 2005. The duplicate
    // recording of Hit Of 2006 is not saved twice.
    expect(await titles(2006)).toEqual(["Another 2006", "Hit Of 2006"]);
    expect(result).toEqual({ saved: 5, byYear: { 2005: 3, 2006: 2 } });

    const saved = await prisma.track.findMany({ where: mine, include: { sources: true } });
    expect(saved.every((t) => t.inPool && t.isrc?.startsWith("HITS"))).toBe(true);
    expect(saved.find((t) => t.title === "Agreed Hit")!.sources.map((s) => s.reference)).toEqual(["hits:2005"]);
    expect(log).toContain("2005: read 2 playlists");
    expect(log).toContain("2006: 2 songs (wanted 3, found 3 candidates)");
  });

  it("re-running adds nothing and looks nothing up again", async () => {
    const before = mock.stats().trackLookups;
    const again = await seedHits(prisma, deezer, { fromYear: 2005, toYear: 2006, perYear: 3 });
    expect(again.saved).toBe(5);
    expect(await prisma.track.count({ where: mine })).toBe(5);
    // Only the candidates that were rejected last time are checked again.
    expect(mock.stats().trackLookups - before).toBeLessThanOrEqual(3);
  });

  it("uses pinned playlists instead of searching", async () => {
    await prisma.track.deleteMany({ where: mine });
    const result = await seedHits(prisma, deezer, { fromYear: 2005, toYear: 2005, perYear: 5, pinned: { "2005": ["5"] } });
    // Playlist 5's songs, minus those released too late for 2005... all but the 2006 ones fit by date window.
    expect(result.byYear[2005]).toBeGreaterThan(0);
    expect(await titles(2005)).toContain("Agreed Hit");
  });
});
