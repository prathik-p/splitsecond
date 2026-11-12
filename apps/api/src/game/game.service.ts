import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, Round, RoundStatus, Track } from "@prisma/client";
import {
  GuessResult,
  LeaderboardEntry,
  PoolTrack,
  RUN_LENGTH,
  RoundState,
  RunState,
  scoreRound,
  snapSeconds,
} from "@splitsecond/shared";
import { PrismaService } from "../prisma/prisma.service";
import { DeezerService } from "../deezer/deezer.service";
import { sliceMp3 } from "../audio/mp3";

type RoundWithTrack = Round & { track: Track };

const STATUS: Record<RoundStatus, RoundState["status"]> = {
  PLAYING: "playing",
  SOLVED: "solved",
  GIVEN_UP: "given_up",
};

@Injectable()
export class GameService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deezer: DeezerService,
  ) {}

  /** Every guessable song, one entry per song even if the pool has several releases. */
  async pool(): Promise<PoolTrack[]> {
    const tracks = await this.prisma.track.findMany({
      where: { inPool: true },
      select: { id: true, title: true, artist: true, songKey: true },
      orderBy: { rank: "desc" },
    });
    const seen = new Set<string>();
    const out: PoolTrack[] = [];
    for (const t of tracks) {
      if (seen.has(t.songKey)) continue;
      seen.add(t.songKey);
      out.push({ id: t.id, title: t.title, artist: t.artist });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  /**
   * Pick RUN_LENGTH songs from the pool, ordered easy to hard: the pool is
   * sorted by Deezer rank and split into RUN_LENGTH bands, one song per band.
   */
  async createRun(nickname?: string | null): Promise<RunState> {
    const pool = await this.prisma.track.findMany({
      where: { inPool: true },
      select: { id: true, songKey: true },
      orderBy: { rank: "desc" },
    });
    const distinct = new Set(pool.map((t) => t.songKey));
    if (distinct.size < RUN_LENGTH) {
      throw new ConflictException(`The song pool needs at least ${RUN_LENGTH} songs. Run the seed first.`);
    }

    const picked: string[] = [];
    const usedKeys = new Set<string>();
    for (let band = 0; band < RUN_LENGTH; band++) {
      const from = Math.floor((band * pool.length) / RUN_LENGTH);
      const to = Math.floor(((band + 1) * pool.length) / RUN_LENGTH);
      const candidates = pool.slice(from, to).filter((t) => !usedKeys.has(t.songKey));
      // A band can run dry if it is full of duplicates; fall back to anything unused.
      const choices = candidates.length ? candidates : pool.filter((t) => !usedKeys.has(t.songKey));
      const choice = choices[Math.floor(Math.random() * choices.length)];
      picked.push(choice.id);
      usedKeys.add(choice.songKey);
    }

    const clean = nickname?.trim().slice(0, 24) || null;
    const run = await this.prisma.run.create({
      data: {
        nickname: clean,
        rounds: { create: picked.map((trackId, index) => ({ trackId, index })) },
      },
    });
    return this.getRun(run.id);
  }

  async getRun(runId: string): Promise<RunState> {
    const run = await this.prisma.run.findUnique({
      where: { id: runId },
      include: { rounds: { include: { track: true }, orderBy: { index: "asc" } } },
    });
    if (!run) throw new NotFoundException("Run not found");
    return {
      runId: run.id,
      nickname: run.nickname,
      totalScore: run.totalScore,
      finished: run.finishedAt !== null,
      rounds: run.rounds.map(toRoundState),
    };
  }

  /** Unlock more of the song. Unlocking only ever goes up. */
  async unlock(roundId: string, seconds: unknown): Promise<RoundState> {
    const requested = Number(seconds);
    if (!Number.isFinite(requested)) throw new BadRequestException("seconds must be a number");
    const round = await this.playableRound(roundId);
    const next = Math.max(round.unlockedSeconds, snapSeconds(requested));
    const updated = await this.prisma.round.update({
      where: { id: round.id },
      data: { unlockedSeconds: next },
      include: { track: true },
    });
    return toRoundState(updated);
  }

  /** The unlocked part of the preview while playing, the whole preview once the round is over. */
  async audio(roundId: string): Promise<Buffer> {
    const round = await this.loadRound(roundId);
    const full = await this.deezer.preview(round.track.deezerId);
    if (round.status !== "PLAYING") return full;
    await this.assertCurrent(round);
    return sliceMp3(full, round.unlockedSeconds).mp3;
  }

  async guess(roundId: string, guessedTrackId: unknown): Promise<GuessResult> {
    if (typeof guessedTrackId !== "string" || !guessedTrackId) {
      throw new BadRequestException("trackId is required");
    }
    const round = await this.playableRound(roundId);
    const guessed = await this.prisma.track.findFirst({ where: { id: guessedTrackId, inPool: true } });
    if (!guessed) throw new BadRequestException("Pick a song from the list");

    const correct = guessed.songKey === round.track.songKey;

    if (!correct) {
      // Guessing the same wrong song twice only costs once.
      const repeat = await this.prisma.guess.findFirst({
        where: { roundId: round.id, correct: false, guessedTrack: { songKey: guessed.songKey } },
      });
      await this.prisma.$transaction([
        this.prisma.guess.create({
          data: { roundId: round.id, guessedTrackId: guessed.id, correct, unlockedSeconds: round.unlockedSeconds },
        }),
        ...(repeat
          ? []
          : [this.prisma.round.update({ where: { id: round.id }, data: { wrongGuesses: { increment: 1 } } })]),
      ]);
      return this.result(false, round.id, round.runId);
    }

    const score = scoreRound(round.unlockedSeconds, round.wrongGuesses);
    await this.endRound(round, "SOLVED", score, (tx) =>
      tx.guess.create({
        data: { roundId: round.id, guessedTrackId: guessed.id, correct, unlockedSeconds: round.unlockedSeconds },
      }),
    );
    return this.result(true, round.id, round.runId);
  }

  async giveUp(roundId: string): Promise<GuessResult> {
    const round = await this.playableRound(roundId);
    await this.endRound(round, "GIVEN_UP", 0);
    return this.result(false, round.id, round.runId);
  }

  async leaderboard(limit = 20): Promise<LeaderboardEntry[]> {
    const runs = await this.prisma.run.findMany({
      where: { finishedAt: { not: null } },
      orderBy: [{ totalScore: "desc" }, { finishedAt: "asc" }],
      take: limit,
    });
    return runs.map((r) => ({
      runId: r.id,
      nickname: r.nickname ?? "Anonymous",
      totalScore: r.totalScore,
      finishedAt: r.finishedAt!.toISOString(),
    }));
  }

  // --- helpers ---

  private async endRound(
    round: RoundWithTrack,
    status: "SOLVED" | "GIVEN_UP",
    score: number,
    extra?: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) {
    await this.prisma.$transaction(async (tx) => {
      // Conditional update so two racing requests can't both end the round.
      const ended = await tx.round.updateMany({
        where: { id: round.id, status: "PLAYING" },
        data: { status, score, endedAt: new Date() },
      });
      if (ended.count === 0) throw new ConflictException("This round is already over");
      if (extra) await extra(tx);
      const remaining = await tx.round.count({ where: { runId: round.runId, status: "PLAYING" } });
      await tx.run.update({
        where: { id: round.runId },
        data: {
          totalScore: { increment: score },
          ...(remaining === 0 ? { finishedAt: new Date() } : {}),
        },
      });
    });
  }

  private async result(correct: boolean, roundId: string, runId: string): Promise<GuessResult> {
    const run = await this.getRun(runId);
    const round = run.rounds.find((r) => r.roundId === roundId)!;
    return { correct, round, run };
  }

  private async loadRound(roundId: string): Promise<RoundWithTrack> {
    const round = await this.prisma.round.findUnique({ where: { id: roundId }, include: { track: true } });
    if (!round) throw new NotFoundException("Round not found");
    return round;
  }

  /** A round can be played only while it is open and it is the run's current round. */
  private async playableRound(roundId: string): Promise<RoundWithTrack> {
    const round = await this.loadRound(roundId);
    if (round.status !== "PLAYING") throw new ConflictException("This round is already over");
    await this.assertCurrent(round);
    return round;
  }

  private async assertCurrent(round: Round) {
    const earlierOpen = await this.prisma.round.count({
      where: { runId: round.runId, status: "PLAYING", index: { lt: round.index } },
    });
    if (earlierOpen > 0) throw new ConflictException("Finish the earlier rounds first");
  }
}

function toRoundState(round: RoundWithTrack): RoundState {
  const over = round.status !== "PLAYING";
  return {
    roundId: round.id,
    index: round.index,
    unlockedSeconds: round.unlockedSeconds,
    wrongGuesses: round.wrongGuesses,
    status: STATUS[round.status],
    score: round.score,
    answer: over
      ? {
          title: round.track.title,
          artist: round.track.artist,
          album: round.track.album,
          coverUrl: round.track.coverUrl,
        }
      : null,
  };
}
