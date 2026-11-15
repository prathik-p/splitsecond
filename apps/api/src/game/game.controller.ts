import { Body, Controller, Get, Header, Param, Post, Query, StreamableFile } from "@nestjs/common";
import { GameService } from "./game.service";

@Controller()
export class GameController {
  constructor(private readonly game: GameService) {}

  /** The default pool's songs. A run's own songs are at runs/:id/pool. */
  @Get("pool")
  pool() {
    return this.game.pool();
  }

  @Get("pool/summary")
  poolSummary() {
    return this.game.poolSummary();
  }

  /** Genres and artists the default pool can be narrowed to, for the lobby's run options. */
  @Get("pool/options")
  poolOptions() {
    return this.game.poolOptions();
  }

  @Post("runs")
  createRun(@Body() body: { nickname?: string; profileId?: string; genres?: string[]; artists?: string[] } = {}) {
    return this.game.createRun(body?.nickname, body?.profileId, { genres: body?.genres, artists: body?.artists });
  }

  @Get("runs/:id/pool")
  runPool(@Param("id") id: string) {
    return this.game.runPool(id);
  }

  @Get("runs/:id")
  getRun(@Param("id") id: string) {
    return this.game.getRun(id);
  }

  @Post("rounds/:id/unlock")
  unlock(@Param("id") id: string, @Body() body: { seconds?: number }) {
    return this.game.unlock(id, body?.seconds);
  }

  /** Audio is proxied so the browser never sees the track's id or preview URL. */
  @Get("rounds/:id/audio")
  @Header("Cache-Control", "no-store")
  async audio(@Param("id") id: string) {
    const clip = await this.game.audio(id);
    return new StreamableFile(clip.data, { type: clip.contentType });
  }

  @Post("rounds/:id/guess")
  guess(@Param("id") id: string, @Body() body: { trackId?: string }) {
    return this.game.guess(id, body?.trackId);
  }

  @Post("rounds/:id/give-up")
  giveUp(@Param("id") id: string) {
    return this.game.giveUp(id);
  }

  @Get("leaderboard")
  leaderboard(@Query("limit") limit?: string, @Query("profileId") profileId?: string) {
    const n = Math.min(100, Math.max(1, Number(limit) || 20));
    return this.game.leaderboard(n, profileId || undefined);
  }
}
