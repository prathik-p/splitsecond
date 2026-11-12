/**
 * Minimal Deezer public API client. No auth needed.
 *
 * Deezer allows about 50 requests per 5 seconds per IP and reports errors
 * inside a 200 response ({ error: { code, message } }), so both are handled here.
 * Preview URLs are signed and expire, so callers fetch a fresh track object
 * right before downloading a preview.
 */

export interface DeezerTrack {
  id: number;
  title: string;
  title_short?: string;
  isrc?: string;
  rank: number;
  duration: number;
  preview: string;
  readable?: boolean;
  artist: { id: number; name: string };
  album: { id: number; title: string; cover_medium?: string };
}

interface DeezerList<T> {
  data: T[];
  total?: number;
  next?: string;
}

export class DeezerError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

const QUOTA_ERROR = 4;

export class DeezerClient {
  private readonly windowMs = 5_000;
  private readonly maxPerWindow = 45; // stay under Deezer's ~50 / 5s
  private readonly sent: number[] = [];

  constructor(private readonly baseUrl = "https://api.deezer.com") {}

  async track(id: number | bigint): Promise<DeezerTrack> {
    return this.get<DeezerTrack>(`/track/${id}`);
  }

  async chartTracks(limit = 100): Promise<DeezerTrack[]> {
    const res = await this.get<DeezerList<DeezerTrack>>(`/chart/0/tracks?limit=${limit}`);
    return res.data;
  }

  async playlistTracks(playlistId: string, max = 400): Promise<DeezerTrack[]> {
    const out: DeezerTrack[] = [];
    let index = 0;
    while (out.length < max) {
      const page = await this.get<DeezerList<DeezerTrack>>(
        `/playlist/${encodeURIComponent(playlistId)}/tracks?limit=100&index=${index}`,
      );
      out.push(...page.data);
      if (!page.next || page.data.length === 0) break;
      index += page.data.length;
    }
    return out.slice(0, max);
  }

  /** Candidates for a song by title and artist: a strict field search, then a loose one. */
  async search(title: string, artist: string, limit = 8): Promise<DeezerTrack[]> {
    const clean = (v: string) => v.replace(/"/g, " ").trim();
    const strict = `artist:"${clean(artist)}" track:"${clean(title)}"`;
    const res = await this.get<DeezerList<DeezerTrack>>(`/search?q=${encodeURIComponent(strict)}&limit=${limit}`);
    if (res.data?.length) return res.data;
    const loose = `${clean(title)} ${clean(artist)}`;
    const fallback = await this.get<DeezerList<DeezerTrack>>(`/search?q=${encodeURIComponent(loose)}&limit=${limit}`);
    return fallback.data ?? [];
  }

  /** Download the 30s preview MP3 for a track, using a freshly signed URL. */
  async previewMp3(id: number | bigint): Promise<Buffer> {
    const track = await this.track(id);
    if (!track.preview) throw new DeezerError(`Track ${id} has no preview`);
    const res = await fetch(track.preview);
    if (!res.ok) throw new DeezerError(`Preview download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private async get<T>(path: string, attempt = 0): Promise<T> {
    await this.throttle();
    const res = await fetch(`${this.baseUrl}${path}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new DeezerError(`Deezer HTTP ${res.status} for ${path}`);
    const body = (await res.json()) as T & { error?: { code?: number; message?: string } };
    if (body && typeof body === "object" && "error" in body && body.error) {
      if (body.error.code === QUOTA_ERROR && attempt < 3) {
        await sleep(1_000 * (attempt + 1));
        return this.get<T>(path, attempt + 1);
      }
      throw new DeezerError(body.error.message ?? "Deezer error", body.error.code);
    }
    return body;
  }

  private async throttle(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (this.sent.length && now - this.sent[0] > this.windowMs) this.sent.shift();
      if (this.sent.length < this.maxPerWindow) {
        this.sent.push(now);
        return;
      }
      await sleep(this.windowMs - (now - this.sent[0]) + 5);
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
