import type { Catalog, CatalogTrack } from "../catalog/types";

/**
 * Apple's public iTunes Search API. No key, works worldwide, and every song
 * result carries a 30 second AAC preview URL.
 *
 * Apple asks for roughly 20 calls a minute, so calls are spaced out here and a
 * 403/429 (their way of saying "slow down") is retried after a pause.
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

export class ItunesError extends Error {}

export interface ItunesOptions {
  baseUrl?: string;
  /** Storefront to search. Previews play anywhere whichever store they come from. */
  country?: string;
  /** Calls allowed per minute. */
  perMinute?: number;
  /** Pause after being rate limited, multiplied by the attempt number. */
  backoffMs?: number;
}

export class ItunesClient implements Catalog {
  readonly provider = "itunes" as const;
  private readonly baseUrl: string;
  private readonly country: string;
  private readonly gapMs: number;
  private readonly backoffMs: number;
  /** Requests queue behind this so they leave one at a time, evenly spaced. */
  private queue: Promise<unknown> = Promise.resolve();
  private nextAt = 0;

  constructor(options: ItunesOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://itunes.apple.com").replace(/\/$/, "");
    this.country = options.country ?? "US";
    this.gapMs = 60_000 / Math.max(1, options.perMinute ?? 19);
    this.backoffMs = options.backoffMs ?? 30_000;
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
    for (let attempt = 0; ; attempt++) {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextAt = Date.now() + this.gapMs;

      const res = await fetch(`${this.baseUrl}${path}`, { headers: { accept: "application/json" } });
      if (res.ok) return (await res.json()) as ItunesResponse;
      if ((res.status === 403 || res.status === 429) && attempt < 3) {
        // Rate limited: back off well past the per-minute window.
        this.nextAt = Date.now() + this.backoffMs * (attempt + 1);
        continue;
      }
      throw new ItunesError(`iTunes HTTP ${res.status}`);
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
