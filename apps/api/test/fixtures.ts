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
}

export function mockDeezerHandler(
  tracks: MockTrack[],
  mp3: Buffer,
  baseUrl: () => string,
  stats = { trackLookups: 0, previewDownloads: 0, searches: 0 },
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
      return res.end(JSON.stringify(t ? json(t) : { error: { code: 800, message: "no data" } }));
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
export async function startMockDeezer(tracks: MockTrack[], mp3: Buffer) {
  const stats = { trackLookups: 0, previewDownloads: 0, searches: 0 };
  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const server: Server = createServer(mockDeezerHandler(tracks, mp3, url, stats));
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
