/**
 * Plays whole runs against a real Postgres and a mock Deezer.
 * Needs DATABASE_URL; skipped otherwise. It only touches rows it creates.
 */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUN_LENGTH, basePoints, songKey } from "@splitsecond/shared";
import { PrismaService } from "../prisma/prisma.service";
import { DeezerService } from "../deezer/deezer.service";
import { GameService } from "./game.service";
import { FRAME_BYTES, fakeMp3, startMockDeezer, MockTrack } from "../../test/fixtures";

const ID_BASE = 990_000_000;
const tracks: MockTrack[] = Array.from({ length: 12 }, (_, i) => ({
  id: ID_BASE + i,
  title: `Test Song ${i}`,
  artist: `Test Artist ${i}`,
  rank: 1_000_000 - i * 50_000,
  isrc: `TEST${String(i).padStart(8, "0")}`,
}));

describe.skipIf(!process.env.DATABASE_URL)("game flow", () => {
  let prisma: PrismaService;
  let game: GameService;
  let mock: Awaited<ReturnType<typeof startMockDeezer>>;
  let previousPool: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    mock = await startMockDeezer(tracks, fakeMp3(1200));
    process.env.DEEZER_API_BASE = mock.url;
    prisma = new PrismaService();
    await prisma.$connect();
    game = new GameService(prisma, new DeezerService());

    // Park any real pool so runs draw only from the test songs.
    const existing = await prisma.track.findMany({ where: { inPool: true }, select: { id: true } });
    previousPool = existing.map((t) => t.id);
    await prisma.track.updateMany({ where: { id: { in: previousPool } }, data: { inPool: false } });
    await prisma.track.createMany({
      data: tracks.map((t) => ({
        deezerId: BigInt(t.id),
        isrc: t.isrc,
        title: t.title,
        artist: t.artist,
        rank: t.rank,
        songKey: songKey(t.title, t.artist),
      })),
    });
  });

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { id: { in: runIds } } });
    await prisma.track.deleteMany({ where: { deezerId: { gte: BigInt(ID_BASE), lt: BigInt(ID_BASE + 100) } } });
    await prisma.track.updateMany({ where: { id: { in: previousPool } }, data: { inPool: true } });
    await prisma.$disconnect();
    await mock.close();
  });

  const newRun = async () => {
    const run = await game.createRun("  tester  ");
    runIds.push(run.runId);
    return run;
  };
  const answerOf = async (roundId: string) =>
    (await prisma.round.findUniqueOrThrow({ where: { id: roundId }, include: { track: true } })).track;

  it("builds a 5-song run ordered easy to hard, without leaking answers", async () => {
    const run = await newRun();
    expect(run.rounds).toHaveLength(RUN_LENGTH);
    expect(run.nickname).toBe("tester");
    expect(run.source).toBeNull();
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

    const first = await game.audio(id);
    expect(first.length).toBeLessThanOrEqual(8 * FRAME_BYTES); // 0.1s plus decoder margin

    expect((await game.unlock(id, 2.07)).unlockedSeconds).toBe(2);
    expect((await game.unlock(id, 0.5)).unlockedSeconds).toBe(2);
    const more = await game.audio(id);
    expect(more.length).toBeGreaterThan(first.length);
    expect(more.length).toBeLessThan(90 * FRAME_BYTES); // ~2s, nowhere near the full clip

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
    expect((await game.audio(r0.roundId)).length).toBe(1200 * FRAME_BYTES);

    const gaveUp = await game.giveUp(r1.roundId);
    expect(gaveUp.round.status).toBe("given_up");
    expect(gaveUp.round.score).toBe(0);
    expect(gaveUp.round.answer).not.toBeNull();
    expect(gaveUp.run.finished).toBe(false);
  });

  it("finishes the run and ranks it on the leaderboard", async () => {
    const run = await newRun();
    let last;
    for (const r of run.rounds) last = await game.guess(r.roundId, (await answerOf(r.roundId)).id);
    expect(last!.run.finished).toBe(true);
    expect(last!.run.totalScore).toBe(RUN_LENGTH * 10_000);

    const board = await game.leaderboard(100);
    const mine = board.find((e) => e.runId === run.runId);
    expect(mine).toMatchObject({ nickname: "tester", totalScore: 50_000 });
    // Unfinished runs are not listed.
    expect(board.every((e) => e.runId !== runIds[0])).toBe(true);
  });

  it("lists the pool for autocomplete", async () => {
    const pool = await game.pool();
    expect(pool).toHaveLength(tracks.length);
    expect(Object.keys(pool[0]).sort()).toEqual(["artist", "id", "title"]);
  });
});
