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
}

export function mockDeezerHandler(
  tracks: MockTrack[],
  mp3: Buffer,
  baseUrl: () => string,
  stats = { trackLookups: 0, previewDownloads: 0 },
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
      return res.end(JSON.stringify({ data: tracks.map((t) => ({ ...json(t), isrc: undefined })) }));
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
  const stats = { trackLookups: 0, previewDownloads: 0 };
  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const server: Server = createServer(mockDeezerHandler(tracks, mp3, url, stats));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: url(),
    stats: () => ({ ...stats }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
