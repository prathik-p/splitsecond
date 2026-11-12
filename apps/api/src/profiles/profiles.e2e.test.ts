/**
 * Imports Last.fm profiles against a real Postgres, a mock Last.fm and a mock Deezer.
 * Needs DATABASE_URL; skipped otherwise. It only touches rows it creates.
 */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUN_LENGTH } from "@splitsecond/shared";
import { PrismaService } from "../prisma/prisma.service";
import { DeezerService } from "../deezer/deezer.service";
import { GameService } from "../game/game.service";
import { ProfilesService } from "./profiles.service";
import { fakeMp3, MockTrack, startMockDeezer, startMockLastfm } from "../../test/fixtures";

const ID_BASE = 980_000_000;
const deezerTracks: MockTrack[] = [
  ...Array.from({ length: 8 }, (_, i) => ({
    id: ID_BASE + i,
    title: `Import Song ${i}`,
    artist: `Import Artist ${i}`,
    rank: 900_000 - i * 100_000,
    isrc: `IMPT${String(i).padStart(8, "0")}`,
  })),
  // Two Deezer ids for one recording (same ISRC): must become one Track.
  { id: ID_BASE + 20, title: "Twin Song", artist: "Twin Artist", rank: 50_000, isrc: "IMPTTWIN0001" },
  { id: ID_BASE + 21, title: "Twin Song (Remastered)", artist: "Twin Artist", rank: 40_000, isrc: "IMPTTWIN0001" },
];

const lastfmUsers = [
  {
    name: "Mira_V",
    top: [
      ...Array.from({ length: 8 }, (_, i) => ({
        title: i === 0 ? "Import Song 0 - Remastered 2011" : `Import Song ${i}`,
        artist: `Import Artist ${i}`,
        playcount: 100 - i,
      })),
      // Same song listed twice under different release names: counts once.
      { title: "Import Song 1 (Live)", artist: "Import Artist 1", playcount: 3 },
      { title: "Twin Song", artist: "Twin Artist", playcount: 2 },
      { title: "Nowhere On Deezer", artist: "Obscure Band", playcount: 1 },
    ],
    loved: [
      { title: "Import Song 3", artist: "Import Artist 3" },
    ],
  },
  { name: "tiny", top: [{ title: "Import Song 2", artist: "Import Artist 2", playcount: 9 }] },
  { name: "nobody", top: [] },
];

describe.skipIf(!process.env.DATABASE_URL)("Last.fm import", () => {
  let prisma: PrismaService;
  let profiles: ProfilesService;
  let game: GameService;
  let deezer: Awaited<ReturnType<typeof startMockDeezer>>;
  let lastfm: Awaited<ReturnType<typeof startMockLastfm>>;
  const runIds: string[] = [];
  const env = { ...process.env };

  beforeAll(async () => {
    deezer = await startMockDeezer(deezerTracks, fakeMp3(100));
    lastfm = await startMockLastfm(lastfmUsers);
    process.env.DEEZER_API_BASE = deezer.url;
    process.env.LASTFM_API_BASE = lastfm.url;
    process.env.LASTFM_API_KEY = "test-key";
    prisma = new PrismaService();
    await prisma.$connect();
    const deezerService = new DeezerService();
    profiles = new ProfilesService(prisma, deezerService);
    game = new GameService(prisma, deezerService);
    await cleanup();
  });

  const cleanup = async () => {
    await prisma.run.deleteMany({ where: { id: { in: runIds } } });
    await prisma.profile.deleteMany({ where: { username: { in: ["mira_v", "tiny", "nobody"] } } });
    await prisma.track.deleteMany({ where: { deezerId: { gte: BigInt(ID_BASE), lt: BigInt(ID_BASE + 100) } } });
  };

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await deezer.close();
    await lastfm.close();
    process.env = env;
  });

  const importAndWait = async (username: string, refresh = false) => {
    const started = await profiles.importLastfm(username, refresh);
    await profiles.whenIdle(started.id);
    return profiles.get(started.id);
  };

  it("rejects bad usernames and unknown users before starting anything", async () => {
    await expect(profiles.importLastfm("no spaces allowed")).rejects.toThrow(/doesn't look like/);
    await expect(profiles.importLastfm("")).rejects.toThrow(/doesn't look like/);
    await expect(profiles.importLastfm("ghost_user")).rejects.toThrow(/no user called "ghost_user"/);
    expect(await prisma.profile.count({ where: { username: "ghost_user" } })).toBe(0);
  });

  it("explains when the API key is missing", async () => {
    const key = process.env.LASTFM_API_KEY;
    delete process.env.LASTFM_API_KEY;
    await expect(profiles.importLastfm("mira_v")).rejects.toThrow(/LASTFM_API_KEY/);
    process.env.LASTFM_API_KEY = key;
  });

  it("imports top and loved tracks, matched to Deezer and deduped", async () => {
    const started = await profiles.importLastfm("mira_v");
    expect(started.status).toBe("running");
    expect(started.displayName).toBe("Mira_V");
    // A second request while it runs joins the same import.
    expect((await profiles.importLastfm("MIRA_V")).id).toBe(started.id);
    await profiles.whenIdle(started.id);

    const done = await profiles.get(started.id);
    // 11 listed, 10 distinct songs, 9 on Deezer.
    expect(done).toMatchObject({ status: "done", total: 10, processed: 10, matched: 9, error: null });
    expect(done.importedAt).not.toBeNull();

    const links = await prisma.profileTrack.findMany({ where: { profileId: done.id }, include: { track: true } });
    expect(links).toHaveLength(9);
    expect(links.every((l) => l.track.inPool === false)).toBe(true);
    expect(links.every((l) => l.track.isrc?.startsWith("IMPT"))).toBe(true);

    const byTitle = Object.fromEntries(links.map((l) => [l.track.title, l]));
    expect(byTitle["Import Song 0"].playcount).toBe(100); // matched despite "- Remastered 2011"
    expect(byTitle["Import Song 1"].playcount).toBe(99); // highest of the duplicate entries
    expect(byTitle["Import Song 3"].loved).toBe(true);
    expect(byTitle["Import Song 4"].loved).toBe(false);
    // Of the two Deezer ids for Twin Song, the more popular one was kept.
    expect(byTitle["Twin Song"].track.deezerId).toBe(BigInt(ID_BASE + 20));
  });

  it("returns an imported profile without re-importing, unless asked to refresh", async () => {
    const before = deezer.stats().searches;
    const again = await importAndWait("mira_v");
    expect(again.status).toBe("done");
    expect(deezer.stats().searches).toBe(before);

    const refreshed = await importAndWait("mira_v", true);
    expect(refreshed).toMatchObject({ status: "done", matched: 9 });
    // Known songs are reused from the database; only the unmatched one is searched again.
    expect(deezer.stats().searches - before).toBeLessThanOrEqual(2);
    expect(await prisma.profileTrack.count({ where: { profileId: refreshed.id } })).toBe(9);
  });

  it("shares one Track between profiles", async () => {
    const tiny = await importAndWait("tiny");
    expect(tiny).toMatchObject({ status: "done", total: 1, matched: 1 });
    const track = await prisma.track.findFirstOrThrow({ where: { title: "Import Song 2" }, include: { profiles: true } });
    expect(track.profiles).toHaveLength(2);
    expect(await prisma.track.count({ where: { title: "Import Song 2" } })).toBe(1);
  });

  it("handles a user with no listening history", async () => {
    expect(await importAndWait("nobody")).toMatchObject({ status: "done", total: 0, matched: 0 });
  });

  it("plays a run from a profile's songs only", async () => {
    const mira = (await profiles.list()).find((p) => p.displayName === "Mira_V")!;
    const run = await game.createRun("tester", mira.id);
    runIds.push(run.runId);
    expect(run.source).toEqual({ profileId: mira.id, displayName: "Mira_V" });
    expect(run.rounds).toHaveLength(RUN_LENGTH);

    const rounds = await prisma.round.findMany({
      where: { runId: run.runId },
      include: { track: { include: { profiles: true } } },
      orderBy: { index: "asc" },
    });
    expect(rounds.every((r) => r.track.profiles.some((p) => p.profileId === mira.id))).toBe(true);
    const ranks = rounds.map((r) => r.track.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));

    const pool = await game.runPool(run.runId);
    expect(pool).toHaveLength(9);

    // Guesses must come from the run's own pool.
    const outsider = await prisma.track.findFirst({ where: { inPool: true, profiles: { none: {} } } });
    if (outsider) {
      await expect(game.guess(rounds[0].id, outsider.id)).rejects.toThrow(/Pick a song/);
    }
    const right = await game.guess(rounds[0].id, rounds[0].trackId);
    expect(right.correct).toBe(true);
    expect(right.run.source?.displayName).toBe("Mira_V");
  });

  it("refuses a run from a profile with too few songs", async () => {
    const tiny = (await profiles.list()).find((p) => p.displayName === "tiny")!;
    await expect(game.createRun(null, tiny.id)).rejects.toThrow(/tiny needs at least 5 matched songs/);
    await expect(game.createRun(null, "missing")).rejects.toThrow(/Profile not found/);
  });

  it("keeps profile runs off the default leaderboard", async () => {
    const mira = (await profiles.list()).find((p) => p.displayName === "Mira_V")!;
    const run = await game.createRun("profile-player", mira.id);
    runIds.push(run.runId);
    for (const r of run.rounds) await game.giveUp(r.roundId);

    expect((await game.leaderboard(100)).some((e) => e.runId === run.runId)).toBe(false);
    expect((await game.leaderboard(100, mira.id)).some((e) => e.runId === run.runId)).toBe(true);
  });

  it("marks interrupted imports as failed on startup", async () => {
    const stuck = await prisma.profile.create({
      data: { source: "lastfm", username: "nobody2", displayName: "nobody2", status: "RUNNING" },
    });
    await profiles.onModuleInit();
    expect(await profiles.get(stuck.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/interrupted/) });
    await prisma.profile.delete({ where: { id: stuck.id } });
  });
});
