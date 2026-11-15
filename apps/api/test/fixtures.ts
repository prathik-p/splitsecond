import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

/** One silent MPEG-1 Layer III frame: 128 kbps, 44.1 kHz, 417 bytes, 1152 samples (~26 ms). */
export const FRAME_BYTES = 417;
export const FRAME_SECONDS = 1152 / 44100;

export function fakeMp3(frames: number, opts: { id3?: boolean; xing?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  if (opts.id3) {
    const tag = Buffer.alloc(10 + 20);
    tag.write("ID3", 0, "latin1");
    tag[3] = 4;
    tag[9] = 20; // synchsafe size
    parts.push(tag);
  }
  const frame = (marker?: string) => {
    const f = Buffer.alloc(FRAME_BYTES);
    f[0] = 0xff;
    f[1] = 0xfb;
    f[2] = 0x90;
    f[3] = 0x00;
    if (marker) f.write(marker, 36, "latin1");
    return f;
  };
  if (opts.xing) parts.push(frame("Info"));
  for (let i = 0; i < frames; i++) parts.push(frame());
  return Buffer.concat(parts);
}

export interface MockTrack {
  id: number;
  title: string;
  artist: string;
  rank: number;
  isrc: string;
  /** false keeps the track out of the chart, so it is only reachable by search. */
  chart?: boolean;
  /** "YYYY-MM-DD", served by /track/:id only, like Deezer. */
  releaseDate?: string;
}

export interface MockPlaylist {
  id: number;
  title: string;
  trackIds: number[];
  /** Reported size; defaults to the real one. Lets a short fixture pass the size filter. */
  nbTracks?: number;
}

export function mockDeezerHandler(
  tracks: MockTrack[],
  mp3: Buffer,
  baseUrl: () => string,
  stats = { trackLookups: 0, previewDownloads: 0, searches: 0 },
  playlists: MockPlaylist[] = [],
) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const base = baseUrl();
    const json = (t: MockTrack) => ({
      id: t.id,
      title: t.title,
      title_short: t.title,
      isrc: t.isrc,
      rank: t.rank,
      duration: 200,
      readable: true,
      preview: `${base}/preview/${t.id}.mp3?sig=${Date.now()}`,
      artist: { id: 1, name: t.artist },
      album: { id: 1, title: `${t.title} (Album)`, cover_medium: null },
    });
    const url = new URL(req.url!, base);
    const trackMatch = url.pathname.match(/^\/track\/(\d+)$/);
    if (trackMatch) {
      stats.trackLookups++;
      const t = tracks.find((x) => x.id === Number(trackMatch[1]));
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify(t ? { ...json(t), release_date: t.releaseDate } : { error: { code: 800, message: "no data" } }),
      );
    }
    if (url.pathname === "/search/playlist") {
      const words = (url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/);
      const hits = playlists.filter((p) => words.every((w) => p.title.toLowerCase().includes(w)));
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          data: hits.map((p) => ({ id: p.id, title: p.title, nb_tracks: p.nbTracks ?? p.trackIds.length, public: true })),
        }),
      );
    }
    const playlistMatch = url.pathname.match(/^\/playlist\/(\d+)\/tracks$/);
    if (playlistMatch) {
      const p = playlists.find((x) => x.id === Number(playlistMatch[1]));
      const data = (p?.trackIds ?? [])
        .map((id) => tracks.find((t) => t.id === id))
        .filter((t): t is MockTrack => !!t)
        .map((t) => ({ ...json(t), isrc: undefined }));
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ data, total: data.length }));
    }
    if (url.pathname === "/chart/0/tracks") {
      res.setHeader("content-type", "application/json");
      // Like Deezer, list endpoints omit the ISRC.
      return res.end(JSON.stringify({ data: tracks.filter((t) => t.chart !== false).map((t) => ({ ...json(t), isrc: undefined })) }));
    }
    if (url.pathname === "/search") {
      // Understands artist:"x" track:"y" like Deezer's advanced search, else matches any word.
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const fields = q.match(/^artist:"(.*)" track:"(.*)"$/);
      const hits = tracks.filter((t) =>
        fields
          ? t.artist.toLowerCase().includes(fields[1]) && t.title.toLowerCase().includes(fields[2])
          : q.includes(t.title.toLowerCase()),
      );
      stats.searches++;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ data: hits.map((t) => ({ ...json(t), isrc: undefined })) }));
    }
    if (url.pathname.startsWith("/preview/")) {
      stats.previewDownloads++;
      res.setHeader("content-type", "audio/mpeg");
      return res.end(mp3);
    }
    res.statusCode = 404;
    res.end();
  };
}

/** Start the stand-in on a free port, for tests. */
export async function startMockDeezer(tracks: MockTrack[], mp3: Buffer, playlists: MockPlaylist[] = []) {
  const stats = { trackLookups: 0, previewDownloads: 0, searches: 0 };
  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const server: Server = createServer(mockDeezerHandler(tracks, mp3, url, stats, playlists));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: url(),
    stats: () => ({ ...stats }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface MockLastfmUser {
  /** Username with its real capitalisation. */
  name: string;
  top: { title: string; artist: string; playcount: number }[];
  loved?: { title: string; artist: string }[];
}

/** A stand-in for ws.audioscrobbler.com/2.0/ covering the three methods the importer uses. */
export function mockLastfmHandler(users: MockLastfmUser[]) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const q = new URL(req.url!, "http://x").searchParams;
    res.setHeader("content-type", "application/json");
    const send = (body: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };
    if (!q.get("api_key")) return send({ error: 10, message: "Invalid API key" }, 403);
    const user = users.find((u) => u.name.toLowerCase() === (q.get("user") ?? "").toLowerCase());
    if (!user) return send({ error: 6, message: "User not found" }, 404);

    switch (q.get("method")) {
      case "user.getinfo":
        return send({ user: { name: user.name } });
      case "user.gettoptracks": {
        const limit = Number(q.get("limit") ?? 50);
        const page = Number(q.get("page") ?? 1);
        const slice = user.top.slice((page - 1) * limit, page * limit);
        const track = slice.map((t, i) => ({
          name: t.title,
          playcount: String(t.playcount),
          artist: { name: t.artist },
          "@attr": { rank: String((page - 1) * limit + i + 1) },
        }));
        return send({
          toptracks: {
            // Last.fm returns a bare object when there is exactly one item.
            track: track.length === 1 ? track[0] : track,
            "@attr": { totalPages: String(Math.max(1, Math.ceil(user.top.length / limit))) },
          },
        });
      }
      case "user.getlovedtracks":
        return send({
          lovedtracks: { track: (user.loved ?? []).map((t) => ({ name: t.title, artist: { name: t.artist } })) },
        });
      default:
        return send({ error: 3, message: "Invalid Method" }, 400);
    }
  };
}

export async function startMockLastfm(users: MockLastfmUser[]) {
  const server: Server = createServer(mockLastfmHandler(users));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/2.0/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface MockItunesSong {
  id: number;
  title: string;
  artist: string;
  /** ISO date, e.g. "2005-03-01T08:00:00Z". */
  releaseDate?: string;
  /** false: listed but without a preview. */
  preview?: boolean;
  /** Apple's primaryGenreName. */
  genre?: string;
}

/** Wikipedia-style year-end page: one wikitable of position / title / artist. */
export function yearEndHtml(rows: { position: number; title: string; artist: string }[]): string {
  const body = rows
    .map(
      (r) =>
        `<tr><th scope="row">${r.position}</th><td>"<a href="/wiki/X" title="X">${r.title}</a>"<sup class="reference">[1]</sup></td>` +
        `<td><a href="/wiki/Y">${r.artist}</a></td></tr>`,
    )
    .join("\n");
  return (
    `<div class="mw-parser-output"><p>Intro text.</p><table class="wikitable sortable"><tbody>` +
    `<tr><th>No.</th><th>Title</th><th>Artist(s)</th></tr>\n${body}</tbody></table></div>`
  );
}

/**
 * Stand-ins for Apple's iTunes Search API (/search, /lookup, previews), Apple's
 * chart feeds (/chart.json, /topsongs.json) and Wikipedia's parse API (/w/api.php), on one server.
 */
export async function startMockApple(
  songs: MockItunesSong[],
  m4a: Buffer,
  options: {
    charts?: Record<number, { position: number; title: string; artist: string }[]>;
    mostPlayed?: number[];
    /** Ids on the older "top songs" feed (/topsongs.json). */
    topSongs?: number[];
    /** Fixed port, for the standalone mock. Defaults to any free port. */
    port?: number;
    /** Delay each search by this long, so import progress is visible. */
    delayMs?: number;
  } = {},
) {
  const stats = { searches: 0, lookups: 0, previewDownloads: 0, rateLimited: 0, hung: 0, wikipedia: 0, chart: 0, topSongs: 0 };
  const wikipediaAt: number[] = [];
  /** Set > 0 to answer that many search calls with 403, like Apple's rate limiter. */
  const control = {
    rejectNext: 0,
    /** Leave this many search calls unanswered, like a connection gone quiet. */
    hangNext: 0,
    previewPath: "/preview",
    /** Answer this many Wikipedia calls with 429 and this Retry-After (seconds), if set. */
    wikipediaRejectNext: 0,
    wikipediaRetryAfter: null as string | null,
    /** Answer this many calls to the most-played feed with 502. */
    chartFailNext: 0,
  };
  const server: Server = createServer((req, res) => {
    if (options.delayMs && req.url?.startsWith("/search")) setTimeout(() => handle(req, res), options.delayMs);
    else handle(req, res);
  });
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = new URL(req.url!, base);
    const json = (body: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    const song = (s: MockItunesSong) => ({
      wrapperType: "track",
      kind: "song",
      trackId: s.id,
      trackName: s.title,
      artistName: s.artist,
      collectionName: `${s.title} - Single`,
      artworkUrl100: `${base}/art/${s.id}/100x100bb.jpg`,
      previewUrl: s.preview === false ? undefined : `${base}${control.previewPath}/${s.id}.m4a`,
      releaseDate: s.releaseDate,
      primaryGenreName: s.genre,
    });

    if (url.pathname === "/search") {
      if (control.hangNext > 0) {
        control.hangNext--;
        stats.hung++;
        setTimeout(() => res.destroy(), 2000).unref();
        return;
      }
      if (control.rejectNext > 0) {
        control.rejectNext--;
        stats.rateLimited++;
        res.statusCode = 403;
        return res.end();
      }
      stats.searches++;
      const words = (url.searchParams.get("term") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      // Like Apple, match loosely: every word of the title, and any word of the artist.
      const hits = songs.filter((s) => {
        const title = s.title.toLowerCase().replace(/\(.*?\)/g, "").split(/\s+/).filter(Boolean);
        return title.every((w) => words.includes(w));
      });
      return json({ resultCount: hits.length, results: hits.map(song) });
    }
    if (url.pathname === "/lookup") {
      stats.lookups++;
      const ids = (url.searchParams.get("id") ?? "").split(",").map(Number);
      const hits = ids.map((id) => songs.find((s) => s.id === id)).filter((s): s is MockItunesSong => !!s);
      return json({ resultCount: hits.length, results: hits.map(song) });
    }
    if (url.pathname.startsWith(`${control.previewPath}/`)) {
      stats.previewDownloads++;
      res.setHeader("content-type", "audio/x-m4a");
      return res.end(m4a);
    }
    if (url.pathname === "/chart.json") {
      stats.chart++;
      if (control.chartFailNext > 0) {
        control.chartFailNext--;
        res.statusCode = 502;
        return res.end();
      }
      return json({ feed: { results: (options.mostPlayed ?? []).map((id) => ({ id: String(id), kind: "songs" })) } });
    }
    if (url.pathname === "/topsongs.json") {
      // The older iTunes feed: ids sit under entry[].id.attributes["im:id"].
      stats.topSongs++;
      const entry = (options.topSongs ?? []).map((id) => ({ id: { label: `${base}/song/${id}`, attributes: { "im:id": String(id) } } }));
      return json({ feed: { entry } });
    }
    if (url.pathname === "/w/api.php") {
      stats.wikipedia++;
      wikipediaAt.push(Date.now());
      if (control.wikipediaRejectNext > 0) {
        control.wikipediaRejectNext--;
        res.statusCode = 429;
        if (control.wikipediaRetryAfter) res.setHeader("retry-after", control.wikipediaRetryAfter);
        return res.end("Too many requests");
      }
      const year = Number(/_of_(\d{4})$/.exec(url.searchParams.get("page") ?? "")?.[1]);
      const rows = options.charts?.[year];
      return json(
        rows
          ? { parse: { title: `Billboard Year-End Hot 100 singles of ${year}`, text: yearEndHtml(rows) } }
          : { error: { code: "missingtitle", info: "The page you specified doesn't exist." } },
      );
    }
    res.statusCode = 404;
    res.end();
  };
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    wikipediaUrl: `${url}/w/api.php`,
    chartUrl: `${url}/chart.json`,
    topSongsUrl: `${url}/topsongs.json`,
    /** When each Wikipedia call arrived, for checking the pacing. */
    wikipediaAt: () => [...wikipediaAt],
    stats: () => ({ ...stats }),
    control,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
