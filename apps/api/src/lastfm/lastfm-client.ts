/**
 * Minimal Last.fm client for a user's public listening data.
 * Needs a free API key (https://www.last.fm/api/account/create).
 *
 * Last.fm reports errors as { error: <code>, message } and sometimes returns
 * a single object where a list is expected, so both are normalised here.
 */

export interface LastfmTrack {
  title: string;
  artist: string;
  playcount: number;
  loved: boolean;
}

export class LastfmError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }

  /** Last.fm code 6 covers "user not found". */
  get notFound() {
    return this.code === 6;
  }
}

/** Last.fm usernames: 2 to 15 letters, digits, "_" or "-". */
export const LASTFM_USERNAME = /^[A-Za-z][A-Za-z0-9_-]{1,14}$/;

const PAGE_SIZE = 200;

export class LastfmClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://ws.audioscrobbler.com/2.0/",
  ) {}

  /** The username as the user wrote it (correct capitalisation). Throws if there is no such user. */
  async displayName(user: string): Promise<string> {
    const res = await this.call<{ user?: { name?: string } }>("user.getinfo", { user });
    return res.user?.name ?? user;
  }

  /** The user's most played tracks of all time, most played first. */
  async topTracks(user: string, max: number): Promise<LastfmTrack[]> {
    const out: LastfmTrack[] = [];
    for (let page = 1; out.length < max; page++) {
      const res = await this.call<{ toptracks?: { track?: unknown; "@attr"?: { totalPages?: string } } }>(
        "user.gettoptracks",
        { user, period: "overall", limit: String(Math.min(PAGE_SIZE, max)), page: String(page) },
      );
      const tracks = list(res.toptracks?.track);
      for (const t of tracks) {
        const parsed = parse(t, false);
        if (parsed) out.push(parsed);
      }
      const pages = Number(res.toptracks?.["@attr"]?.totalPages ?? 1);
      if (tracks.length === 0 || page >= pages) break;
    }
    return out.slice(0, max);
  }

  /** Tracks the user marked as loved, newest first. */
  async lovedTracks(user: string, max: number): Promise<LastfmTrack[]> {
    const res = await this.call<{ lovedtracks?: { track?: unknown } }>("user.getlovedtracks", {
      user,
      limit: String(Math.min(PAGE_SIZE, max)),
    });
    return list(res.lovedtracks?.track)
      .map((t) => parse(t, true))
      .filter((t): t is LastfmTrack => t !== null)
      .slice(0, max);
  }

  private async call<T>(method: string, params: Record<string, string>): Promise<T> {
    const url = new URL(this.baseUrl);
    url.search = new URLSearchParams({ method, ...params, api_key: this.apiKey, format: "json" }).toString();
    const res = await fetch(url, { headers: { accept: "application/json" } });
    let body: (T & { error?: number; message?: string }) | null = null;
    try {
      body = (await res.json()) as T & { error?: number; message?: string };
    } catch {
      // fall through to the HTTP status
    }
    if (body && typeof body.error === "number") throw new LastfmError(body.message ?? "Last.fm error", body.error);
    if (!res.ok || !body) throw new LastfmError(`Last.fm HTTP ${res.status}`);
    return body;
  }
}

function list(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
}

function parse(raw: Record<string, unknown>, loved: boolean): LastfmTrack | null {
  const title = typeof raw.name === "string" ? raw.name.trim() : "";
  const artistField = raw.artist as { name?: unknown; "#text"?: unknown } | undefined;
  const artistName = artistField?.name ?? artistField?.["#text"];
  const artist = typeof artistName === "string" ? artistName.trim() : "";
  if (!title || !artist) return null;
  return { title, artist, playcount: Number(raw.playcount) || 0, loved };
}
