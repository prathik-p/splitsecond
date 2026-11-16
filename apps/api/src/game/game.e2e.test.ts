/**
 * Plays whole runs against a real Postgres and a mock iTunes.
 * Needs DATABASE_URL; skipped otherwise. It only touches rows it creates.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUN_LENGTH, basePoints, songKey } from "@splitsecond/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CatalogService } from "../catalog/catalog.service";
import { GameService } from "./game.service";
import { sliceM4a } from "../audio/m4a";
import { MockItunesSong, startMockApple } from "../../test/fixtures";

const ID_BASE = 990_000_000;
const m4a = readFileSync(join(__dirname, "../../test/data/tone-fast.m4a")); // 3 seconds
const tracks = Array.from({ length: 12 }, (_, i) => ({
  id: ID_BASE + i,
  title: `Test Song ${i}`,
  artist: `Test Artist ${i}`,
  rank: 1_000_000 - i * 50_000,
}));
const songs: MockItunesSong[] = tracks.map((t) => ({ id: t.id, title: t.title, artist: t.artist }));

describe.skipIf(!process.env.DATABASE_URL)("game flow", () => {
  let prisma: PrismaService;
  let game: GameService;
  let mock: Awaited<ReturnType<typeof startMockApple>>;
  let previousPool: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    mock = await startMockApple(songs, m4a);
    process.env.ITUNES_API_BASE = mock.url;
    prisma = new PrismaService();
    await prisma.$connect();
    game = new GameService(prisma, new CatalogService(prisma));

    // Park any real pool so runs draw only from the test songs.
    const existing = await prisma.track.findMany({ where: { inPool: true }, select: { id: true } });
    previousPool = existing.map((t) => t.id);
    await prisma.track.updateMany({ where: { id: { in: previousPool } }, data: { inPool: false } });
    await prisma.track.createMany({
      data: tracks.map((t) => ({
        itunesId: BigInt(t.id),
        previewUrl: `${mock.url}/preview/${t.id}.m4a`,
        title: t.title,
        artist: t.artist,
        rank: t.rank,
        // Seven pop songs, then five rock songs.
        genre: t.id - ID_BASE < 7 ? "Pop" : "Rock",
        songKey: songKey(t.title, t.artist),
      })),
    });
  });

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { id: { in: runIds } } });
    await prisma.track.deleteMany({ where: { itunesId: { gte: BigInt(ID_BASE), lt: BigInt(ID_BASE + 100) } } });
    await prisma.track.updateMany({ where: { id: { in: previousPool } }, data: { inPool: true } });
    await prisma.$disconnect();
    await mock.close();
  });

  const newRun = async () => {
    const run = await game.createRun();
    runIds.push(run.runId);
    return run;
  };
  const answerOf = async (roundId: string) =>
    (await prisma.round.findUniqueOrThrow({ where: { id: roundId }, include: { track: true } })).track;

  it("lists the genres and artists a run can be limited to", async () => {
    const options = await game.poolOptions();
    expect(options.genres).toEqual(["Pop", "Rock"]);
    expect(options.artists).toHaveLength(12);
    expect(options.songs).toHaveLength(12);
    expect(options.songs.filter((s) => s.g === 1)).toHaveLength(5);
    expect(JSON.stringify(options)).not.toMatch(/Test Song/);
  });

  it("limits a run to the chosen genres and artists", async () => {
    const rock = await game.createRun({ genres: ["Rock"] });
    runIds.push(rock.runId);
    expect(rock.filters).toEqual({ genres: ["Rock"], artists: [] });
    const rockAnswers = await Promise.all(rock.rounds.map((r) => answerOf(r.roundId)));
    expect(rockAnswers.map((t) => t.genre)).toEqual(Array(RUN_LENGTH).fill("Rock"));
    // Still easy to hard within the narrowed pool.
    expect(rockAnswers.map((t) => t.rank)).toEqual([...rockAnswers.map((t) => t.rank)].sort((a, b) => b - a));
    expect((await game.getRun(rock.runId)).filters).toEqual({ genres: ["Rock"], artists: [] });

    const names = [1, 3, 5, 8, 10, 11].map((i) => `Test Artist ${i}`);
    const picked = await game.createRun({ artists: names });
    runIds.push(picked.runId);
    const artists = (await Promise.all(picked.rounds.map((r) => answerOf(r.roundId)))).map((t) => t.artist);
    expect(artists.every((a) => names.includes(a))).toBe(true);
    expect(new Set(artists).size).toBe(RUN_LENGTH);

    // Songs outside the options can still be guessed (and are simply wrong).
    const [first] = picked.rounds;
    const outsider = await prisma.track.findFirstOrThrow({ where: { itunesId: BigInt(ID_BASE) } });
    expect((await game.guess(first.roundId, outsider.id)).correct).toBe(false);
  });

  it("refuses options that leave too few songs, saying how many there are", async () => {
    await expect(game.createRun({ genres: ["Pop"], artists: ["Test Artist 2", "Test Artist 9"] })).rejects.toThrow(
      /Only 1 song matches these options/,
    );
    await expect(game.createRun({ artists: ["Nobody At All"] })).rejects.toThrow(/Only 0 songs match/);
  });

  it("builds a 5-song run ordered easy to hard, without leaking answers", async () => {
    const run = await newRun();
    expect(run.rounds).toHaveLength(RUN_LENGTH);
    expect(run.filters).toEqual({ genres: [], artists: [] });
    expect(run.rounds.every((r) => r.answer === null && r.status === "playing")).toBe(true);
    expect(JSON.stringify(run)).not.toMatch(/Test Song|9900000/);

    const ranks = [];
    for (const r of run.rounds) ranks.push((await answerOf(r.roundId)).rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    expect(new Set(ranks).size).toBe(RUN_LENGTH);
  });

  it("serves only the unlocked audio, and unlocking never goes down", async () => {
    const run = await newRun();
    const id = run.rounds[0].roundId;

    const first = (await game.audio(id)).data;
    expect(first.length).toBe(sliceM4a(m4a, 0.1).aac.length);

    expect((await game.unlock(id, 2.07)).unlockedSeconds).toBe(2);
    expect((await game.unlock(id, 0.5)).unlockedSeconds).toBe(2);
    const more = (await game.audio(id)).data;
    expect(more.length).toBe(sliceM4a(m4a, 2).aac.length);
    expect(more.length).toBeGreaterThan(first.length);
    expect(more.length).toBeLessThan(sliceM4a(m4a, Infinity).aac.length);

    await expect(game.unlock(id, "abc")).rejects.toThrow();
    // Later rounds stay locked until the current one is done.
    await expect(game.audio(run.rounds[1].roundId)).rejects.toThrow(/earlier rounds/);
    await expect(game.unlock(run.rounds[1].roundId, 5)).rejects.toThrow(/earlier rounds/);
  });

  it("downloads each preview once however often it is replayed", async () => {
    const run = await newRun();
    const before = mock.stats().previewDownloads;
    await Promise.all([game.audio(run.rounds[0].roundId), game.audio(run.rounds[0].roundId)]);
    await game.audio(run.rounds[0].roundId);
    expect(mock.stats().previewDownloads - before).toBeLessThanOrEqual(1);
  });

  it("scores wrong guesses, correct guesses and give-ups", async () => {
    const run = await newRun();
    const [r0, r1] = run.rounds;
    const answer0 = await answerOf(r0.roundId);
    const wrongTrack = await prisma.track.findFirstOrThrow({
      where: { inPool: true, songKey: { not: answer0.songKey } },
    });

    // Wrong guess: costs 500, keeps the round open, repeat of the same guess is free.
    const wrong = await game.guess(r0.roundId, wrongTrack.id);
    expect(wrong.correct).toBe(false);
    expect(wrong.round.status).toBe("playing");
    expect(wrong.round.wrongGuesses).toBe(1);
    expect(wrong.round.answer).toBeNull();
    expect((await game.guess(r0.roundId, wrongTrack.id)).round.wrongGuesses).toBe(1);

    await expect(game.guess(r0.roundId, "nope")).rejects.toThrow(/Pick a song/);

    await game.unlock(r0.roundId, 1);
    const right = await game.guess(r0.roundId, answer0.id);
    expect(right.correct).toBe(true);
    expect(right.round.status).toBe("solved");
    expect(right.round.score).toBe(basePoints(1) - 500);
    expect(right.round.answer?.title).toBe(answer0.title);
    expect(right.run.totalScore).toBe(basePoints(1) - 500);

    // A finished round can't be played again, but its full preview is available.
    await expect(game.guess(r0.roundId, answer0.id)).rejects.toThrow(/already over/);
    await expect(game.unlock(r0.roundId, 30)).rejects.toThrow(/already over/);
    const full = await game.audio(r0.roundId);
    expect(full.data.length).toBe(sliceM4a(m4a, Infinity).aac.length);
    expect(full.contentType).toBe("audio/aac");

    const gaveUp = await game.giveUp(r1.roundId);
    expect(gaveUp.round.status).toBe("given_up");
    expect(gaveUp.round.score).toBe(0);
    expect(gaveUp.round.answer).not.toBeNull();
    expect(gaveUp.run.finished).toBe(false);
  });

  it("finishes the run once every round is over", async () => {
    const run = await newRun();
    let last;
    for (const r of run.rounds) last = await game.guess(r.roundId, (await answerOf(r.roundId)).id);
    expect(last!.run.finished).toBe(true);
    expect(last!.run.totalScore).toBe(RUN_LENGTH * 10_000);
  });

  it("lists the pool for autocomplete", async () => {
    const pool = await game.pool();
    expect(pool).toHaveLength(tracks.length);
    expect(Object.keys(pool[0]).sort()).toEqual(["artist", "id", "title"]);
  });
});
