/**
 * Seeds Billboard year-end hits and plays them, against a real Postgres and
 * mock Wikipedia and iTunes servers. Needs DATABASE_URL; skipped otherwise.
 * It only touches rows it creates.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { CatalogService } from "../catalog/catalog.service";
import { GameService } from "../game/game.service";
import { ItunesClient } from "../itunes/itunes-client";
import { currentChartIds, seedAppleChart } from "./apple-chart";
import { seedBillboard } from "./billboard-seeder";
import { WikipediaCharts } from "./wikipedia-charts";
import { MockItunesSong, startMockApple } from "../../test/fixtures";

const ID = 960_000_000;
const m4a = readFileSync(join(__dirname, "../../test/data/tone-fast.m4a")); // 3 seconds

const songs: MockItunesSong[] = [
  { id: ID + 1, title: "First Of 2005", artist: "Alpha", releaseDate: "2005-01-10T08:00:00Z" },
  { id: ID + 2, title: "Second Of 2005 (feat. Guest)", artist: "Beta", releaseDate: "2004-11-01T08:00:00Z" },
  { id: ID + 3, title: "Third Of 2005", artist: "Gamma Karaoke Crew", releaseDate: "2012-01-01T08:00:00Z" },
  { id: ID + 4, title: "Fourth Of 2005", artist: "D!lta", releaseDate: "2005-05-05T08:00:00Z" },
  { id: ID + 5, title: "No Preview Song", artist: "Epsilon", preview: false },
  { id: ID + 6, title: "First Of 2006", artist: "Zeta", releaseDate: "2006-02-02T08:00:00Z" },
  { id: ID + 7, title: "Second Of 2006", artist: "Eta", releaseDate: "2006-03-03T08:00:00Z" },
  { id: ID + 8, title: "Third Of 2006", artist: "Theta", releaseDate: "2006-04-04T08:00:00Z" },
  { id: ID + 9, title: "Right Now Hit", artist: "Iota", releaseDate: "2026-06-01T08:00:00Z" },
  { id: ID + 10, title: "Old Song Charting Again", artist: "Kappa", releaseDate: "1985-06-01T08:00:00Z" },
];

const charts = {
  2005: [
    { position: 1, title: "First Of 2005", artist: "Alpha" },
    { position: 2, title: "Second Of 2005", artist: "Beta featuring Guest" },
    { position: 3, title: "Third Of 2005", artist: "Gamma" }, // only a karaoke version exists
    { position: 4, title: "Fourth Of 2005", artist: "Dilta" }, // stylised on iTunes
    { position: 5, title: "No Preview Song", artist: "Epsilon" },
    { position: 6, title: "Not On Itunes At All", artist: "Nobody" },
  ],
  2006: [
    { position: 1, title: "First Of 2006", artist: "Zeta" },
    { position: 2, title: "First Of 2005", artist: "Alpha" }, // still charting a year later
    { position: 3, title: "Second Of 2006", artist: "Eta" },
    { position: 4, title: "Third Of 2006", artist: "Theta" },
  ],
};

describe.skipIf(!process.env.DATABASE_URL)("Billboard seed on iTunes", () => {
  let prisma: PrismaService;
  let mock: Awaited<ReturnType<typeof startMockApple>>;
  let itunes: ItunesClient;
  let wikipedia: WikipediaCharts;
  let previousPool: string[] = [];
  const runIds: string[] = [];
  const mine = { itunesId: { gte: BigInt(ID), lt: BigInt(ID + 100) } };

  beforeAll(async () => {
    mock = await startMockApple(songs, m4a, { charts, mostPlayed: [ID + 9, ID + 10, ID + 6], topSongs: [ID + 6, ID + 9] });
    itunes = new ItunesClient({ baseUrl: mock.url, perMinute: 60_000 });
    wikipedia = new WikipediaCharts(mock.wikipediaUrl, { gapMs: 0, backoffMs: 5 });
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.track.deleteMany({ where: mine });
    // Park any real pool so runs draw only from the test songs.
    const existing = await prisma.track.findMany({ where: { inPool: true }, select: { id: true } });
    previousPool = existing.map((t) => t.id);
    await prisma.track.updateMany({ where: { id: { in: previousPool } }, data: { inPool: false } });
  });

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { id: { in: runIds } } });
    await prisma.track.deleteMany({ where: mine });
    await prisma.track.updateMany({ where: { id: { in: previousPool } }, data: { inPool: true } });
    await prisma.$disconnect();
    await mock.close();
  });

  const seed = (log: string[] = []) =>
    seedBillboard(prisma, itunes, wikipedia, { fromYear: 2004, toYear: 2006, perYear: 5, log: (m) => log.push(m) });

  it("saves each year's chart songs with year, rank and preview", async () => {
    const log: string[] = [];
    const result = await seed(log);
    // 2005: positions 1, 2 and 4 match; 3 is a karaoke act, 5 has no preview; 6 is beyond perYear.
    expect(result).toEqual({ saved: 7, missed: 2, unread: [], byYear: { 2004: 0, 2005: 3, 2006: 4 } });
    expect(log).toContain("2004: no year-end chart published yet");

    const saved = await prisma.track.findMany({ where: mine, orderBy: { itunesId: "asc" }, include: { sources: true } });
    expect(saved.map((t) => t.title)).toEqual([
      "First Of 2005",
      "Second Of 2005 (feat. Guest)",
      "Fourth Of 2005",
      "First Of 2006",
      "Second Of 2006",
      "Third Of 2006",
    ]);
    expect(saved.every((t) => t.inPool && t.deezerId === null && t.previewUrl?.endsWith(".m4a"))).toBe(true);
    expect(saved[0].coverUrl).toMatch(/300x300bb\.jpg$/);

    // On both years' charts: keeps the first year and the better position.
    const first = saved[0];
    expect(first.year).toBe(2005);
    expect(first.rank).toBe(1_000_000);
    expect(first.sources.map((s) => s.reference).sort()).toEqual(["2005:1", "2006:2"]);
    expect(saved[2]).toMatchObject({ artist: "D!lta", year: 2005, rank: 970_000 });
  });

  it("re-running only retries the entries that were missed", async () => {
    const before = mock.stats().searches;
    const again = await seed();
    expect(again.saved).toBe(7);
    expect(mock.stats().searches - before).toBe(2);
    expect(await prisma.track.count({ where: mine })).toBe(6);
  });

  it("waits and retries when Apple rate-limits", async () => {
    await prisma.track.deleteMany({ where: { itunesId: BigInt(ID + 8) } });
    const patient = new ItunesClient({ baseUrl: mock.url, perMinute: 60_000, backoffMs: 5 });
    mock.control.rejectNext = 2;
    const hits = await patient.search("Third Of 2006", "Theta");
    expect(hits.map((h) => h.id)).toEqual([String(ID + 8)]);
    expect(mock.stats().rateLimited).toBe(2);

    // Three refusals in a row and it gives up, rather than hanging the seed.
    mock.control.rejectNext = 4;
    await expect(patient.search("Third Of 2006", "Theta")).rejects.toThrow(/403/);
    mock.control.rejectNext = 0;
    await seed();
  });

  it("spaces out Wikipedia requests and waits out a 'too many requests'", async () => {
    const paced = new WikipediaCharts(mock.wikipediaUrl, { gapMs: 60, backoffMs: 5 });
    const waits: number[] = [];
    const patient = new WikipediaCharts(mock.wikipediaUrl, { gapMs: 0, backoffMs: 5, onWait: (s) => waits.push(s) });

    const before = mock.wikipediaAt().length;
    await Promise.all([paced.yearEnd(2004), paced.yearEnd(2005), paced.yearEnd(2006)]);
    const at = mock.wikipediaAt().slice(before);
    expect(at).toHaveLength(3);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(45);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(45);

    // Two refusals, the first naming how long to wait, then the page.
    mock.control.wikipediaRejectNext = 2;
    mock.control.wikipediaRetryAfter = "0";
    expect(await patient.yearEnd(2005)).toHaveLength(6);
    expect(waits).toHaveLength(2);
    mock.control.wikipediaRetryAfter = null;
  });

  it("reports a chart it couldn't read as unread, not as unpublished", async () => {
    const impatient = new WikipediaCharts(mock.wikipediaUrl, { gapMs: 0, backoffMs: 1, attempts: 2 });
    mock.control.wikipediaRejectNext = 2; // 2004 fails twice and is given up on
    const log: string[] = [];
    const result = await seedBillboard(prisma, itunes, impatient, {
      fromYear: 2004,
      toYear: 2007,
      perYear: 5,
      log: (m) => log.push(m),
    });
    expect(result.unread).toEqual([2004]);
    expect(log.filter((m) => m.startsWith("2004:"))).toEqual(["2004: couldn't read the chart (Wikipedia HTTP 429)"]);
    expect(log.filter((m) => m.startsWith("2007:"))).toEqual(["2007: no year-end chart published yet"]);
    expect(result.byYear[2005]).toBeGreaterThan(0);
    // The year that failed is picked up by the next run.
    expect((await seed()).unread).toEqual([]);
  });

  it("falls back to Apple's other chart feed when the first is down", async () => {
    const before = mock.stats();
    mock.control.chartFailNext = 2; // both tries of the first feed
    const { ids, feedUrl } = await currentChartIds([mock.chartUrl, mock.topSongsUrl], 1);
    expect(feedUrl).toBe(mock.topSongsUrl);
    expect(ids).toEqual([String(ID + 6), String(ID + 9)]);
    expect(mock.stats().chart - before.chart).toBe(2);

    // One bad answer is retried on the same feed.
    mock.control.chartFailNext = 1;
    expect((await currentChartIds([mock.chartUrl, mock.topSongsUrl], 1)).feedUrl).toBe(mock.chartUrl);

    mock.control.chartFailNext = 2;
    await expect(currentChartIds([mock.chartUrl], 1)).rejects.toThrow(/502/);
    mock.control.chartFailNext = 0;
  });

  it("adds Apple's current most-played songs, skipping ones older than the range", async () => {
    const n = await seedAppleChart(prisma, itunes, { feedUrls: [mock.chartUrl], fromYear: 2000 });
    expect(n).toBe(2); // the 1985 song is left out
    const now = await prisma.track.findFirstOrThrow({ where: { itunesId: BigInt(ID + 9) } });
    expect(now).toMatchObject({ title: "Right Now Hit", year: 2026, rank: 1_000_000, inPool: true });
    // Already in the pool from the 2006 chart: kept as one track, year unchanged.
    const zeta = await prisma.track.findMany({ where: { title: "First Of 2006" } });
    expect(zeta).toHaveLength(1);
    expect(zeta[0].year).toBe(2006);
    expect(await prisma.track.count({ where: { itunesId: BigInt(ID + 10) } })).toBe(0);
  });

  it("plays a run on iTunes tracks, serving only the unlocked AAC", async () => {
    process.env.MUSIC_PROVIDER = "itunes";
    process.env.ITUNES_API_BASE = mock.url;
    process.env.ITUNES_PER_MINUTE = "60000";
    const music = new CatalogService(prisma);
    const game = new GameService(prisma, music);

    const run = await game.createRun();
    runIds.push(run.runId);
    const id = run.rounds[0].roundId;

    const downloads = mock.stats().previewDownloads;
    const first = await game.audio(id);
    expect(first.contentType).toBe("audio/aac");
    expect(first.data[0]).toBe(0xff);
    expect(first.data[1]).toBe(0xf1);
    const full = m4a.length;
    expect(first.data.length).toBeLessThan(full / 5); // ~0.2s of a 3s file

    await game.unlock(id, 1);
    const more = await game.audio(id);
    expect(more.data.length).toBeGreaterThan(first.data.length * 3);
    expect(more.data.length).toBeLessThan(full / 2);
    expect(mock.stats().previewDownloads - downloads).toBe(1); // cached between plays

    const answer = await prisma.round.findUniqueOrThrow({ where: { id }, include: { track: true } });
    const solved = await game.guess(id, answer.trackId);
    expect(solved.round.answer).toMatchObject({ title: answer.track.title, year: answer.track.year });
    // After the round, the whole preview.
    const whole = await game.audio(id);
    expect(whole.data.length).toBeGreaterThan(more.data.length * 2);
  });

  it("asks Apple for a fresh preview URL when the stored one stops working", async () => {
    const music = new CatalogService(prisma);
    const track = await prisma.track.findFirstOrThrow({ where: { itunesId: BigInt(ID + 7) } });
    await prisma.track.update({ where: { id: track.id }, data: { previewUrl: `${mock.url}/gone/x.m4a` } });
    const stale = await prisma.track.findUniqueOrThrow({ where: { id: track.id } });

    const clip = await music.clip(stale, 0.5);
    expect(clip.contentType).toBe("audio/aac");
    const healed = await prisma.track.findUniqueOrThrow({ where: { id: track.id } });
    expect(healed.previewUrl).toBe(`${mock.url}/preview/${ID + 7}.m4a`);
  });
});
