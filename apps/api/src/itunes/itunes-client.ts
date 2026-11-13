import type { Catalog, CatalogTrack } from "../catalog/types";

/**
 * Apple's public iTunes Search API. No key, works worldwide, and every song
 * result carries a 30 second AAC preview URL.
 *
 * Apple asks for roughly 20 calls a minute, so calls are spaced out here. A
 * 403/429 (their way of saying "slow down") is retried after a pause and slows
 * the pace from then on; a request that gets no answer is cut off and retried.
 */

interface ItunesSong {
  wrapperType?: string;
  kind?: string;
  trackId?: number;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  artworkUrl100?: string;
  previewUrl?: string;
  releaseDate?: string;
}

interface ItunesResponse {
  resultCount: number;
  results: ItunesSong[];
}

export class ItunesError extends Error {
  constructor(
    message: string,
    /** True when Apple kept answering "slow down" until the tries ran out. */
    readonly rateLimited = false,
  ) {
    super(message);
  }
}

export interface ItunesOptions {
  baseUrl?: string;
  /** Storefront to search. Previews play anywhere whichever store they come from. */
  country?: string;
  /** Calls allowed per minute. */
  perMinute?: number;
  /** Pause after being rate limited, multiplied by the attempt number (capped at five minutes). */
  backoffMs?: number;
  /** Pause after a dropped connection or server error, multiplied by the attempt number. */
  retryMs?: number;
  /** Give up on a single request that hasn't answered after this long. */
  timeoutMs?: number;
  /** How many times to try one call before giving up. */
  attempts?: number;
  /** Called before each wait for a retry, so a long pause isn't silent. */
  onWait?: (wait: { seconds: number; reason: string; rateLimited: boolean; perMinute: number }) => void;
}

/** After a "slow down", never pace slower than this many calls a minute. */
const SLOWEST_PER_MINUTE = 8;

export class ItunesClient implements Catalog {
  readonly provider = "itunes" as const;
  private readonly baseUrl: string;
  private readonly country: string;
  private gapMs: number;
  private readonly backoffMs: number;
  private readonly retryMs: number;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly onWait?: ItunesOptions["onWait"];
  /** Requests queue behind this so they leave one at a time, evenly spaced. */
  private queue: Promise<unknown> = Promise.resolve();
  private nextAt = 0;

  constructor(options: ItunesOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://itunes.apple.com").replace(/\/$/, "");
    this.country = options.country ?? "US";
    this.gapMs = 60_000 / Math.max(1, options.perMinute ?? 19);
    this.backoffMs = options.backoffMs ?? 30_000;
    this.retryMs = options.retryMs ?? 5_000;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.attempts = Math.max(1, options.attempts ?? 4);
    this.onWait = options.onWait;
  }

  /** The current pace. It drops each time Apple says "slow down". */
  get perMinute(): number {
    return Math.round(60_000 / this.gapMs);
  }

  async search(title: string, artist: string, limit = 10): Promise<CatalogTrack[]> {
    const params = new URLSearchParams({
      term: `${title} ${artist}`,
      media: "music",
      entity: "song",
      country: this.country,
      limit: String(limit),
    });
    const res = await this.get(`/search?${params}`);
    return res.results.map(toTrack).filter((t): t is CatalogTrack => t !== null);
  }

  async track(id: string): Promise<CatalogTrack | null> {
    const [track] = await this.tracks([id]);
    return track ?? null;
  }

  /** Look up many tracks in one call (Apple allows up to 200 ids). */
  async tracks(ids: string[]): Promise<CatalogTrack[]> {
    const out: CatalogTrack[] = [];
    for (let i = 0; i < ids.length; i += 150) {
      const params = new URLSearchParams({ id: ids.slice(i, i + 150).join(","), entity: "song", country: this.country });
      const res = await this.get(`/lookup?${params}`);
      out.push(...res.results.map(toTrack).filter((t): t is CatalogTrack => t !== null));
    }
    return out;
  }

  private get(path: string): Promise<ItunesResponse> {
    const run = this.queue.then(() => this.send(path));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(path: string): Promise<ItunesResponse> {
    for (let attempt = 1; ; attempt++) {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextAt = Date.now() + this.gapMs;

      let reason: string;
      let pause: number;
      let rateLimited = false;
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          headers: { accept: "application/json" },
          // Without this a connection that goes quiet would hang for minutes.
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) return (await res.json()) as ItunesResponse;
        await res.arrayBuffer().catch(() => undefined); // free the connection
        if (res.status === 403 || res.status === 429) {
          // Rate limited: back off well past the per-minute window, and go slower from here on.
          rateLimited = true;
          const asked = Number(res.headers.get("retry-after"));
          pause = Math.min(300_000, asked > 0 ? asked * 1000 : this.backoffMs * attempt);
          this.gapMs = Math.max(this.gapMs, Math.min(this.gapMs * 1.4, 60_000 / SLOWEST_PER_MINUTE));
        } else if (res.status >= 500) {
          pause = this.retryMs * attempt;
        } else {
          throw new ItunesError(`iTunes HTTP ${res.status}`);
        }
        reason = `iTunes HTTP ${res.status}`;
      } catch (err) {
        if (err instanceof ItunesError) throw err;
        const timedOut = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
        reason = timedOut
          ? `no answer from iTunes in ${Math.round(this.timeoutMs / 1000)}s`
          : `couldn't reach iTunes (${((err as Error).cause as Error | undefined)?.message ?? (err as Error).message})`;
        pause = this.retryMs * attempt;
      }

      if (attempt >= this.attempts) throw new ItunesError(reason, rateLimited);
      this.onWait?.({ seconds: Math.ceil(pause / 1000), reason, rateLimited, perMinute: this.perMinute });
      this.nextAt = Date.now() + Math.max(pause, this.gapMs);
    }
  }
}

function toTrack(song: ItunesSong): CatalogTrack | null {
  if (song.wrapperType !== "track" || (song.kind && song.kind !== "song")) return null;
  if (!song.trackId || !song.trackName || !song.artistName) return null;
  return {
    provider: "itunes",
    id: String(song.trackId),
    title: song.trackName,
    artist: song.artistName,
    album: song.collectionName ?? null,
    // Apple serves any size from the same path; 100px is too small for the reveal card.
    coverUrl: song.artworkUrl100?.replace(/\/100x100(bb)?\./, "/300x300$1.") ?? null,
    rank: 0,
    isrc: null,
    releaseDate: song.releaseDate ?? null,
    previewUrl: song.previewUrl ?? null,
    playable: !!song.previewUrl,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
