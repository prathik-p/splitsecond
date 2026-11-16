import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

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
  /** The album it is on and the artist it is filed under, for catalogue lookups. */
  albumId?: number;
  albumName?: string;
  artistId?: number;
  /** Whole song length. */
  durationMs?: number;
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
    /** Artists that can be searched for and looked up; their albums come from the songs' albumId. */
    artists?: { id: number; name: string }[];
    /** Albums listed for an artist but filed under someone else (appearances). */
    appearsOn?: Record<number, { id: number; name: string; artistId: number }[]>;
    /** Ids on the older "top songs" feed (/topsongs.json). */
    topSongs?: number[];
    /** Fixed port, for the standalone mock. Defaults to any free port. */
    port?: number;
    /** Delay each search by this long, so import progress is visible. */
    delayMs?: number;
  } = {},
) {
  const stats = { searches: 0, lookups: 0, previewDownloads: 0, rateLimited: 0, hung: 0, albumLookups: 0, wikipedia: 0, chart: 0, topSongs: 0 };
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
      artistId: s.artistId,
      collectionId: s.albumId,
      trackTimeMillis: s.durationMs,
      ...(s.albumName ? { collectionName: s.albumName } : {}),
    });
    const artistRow = (a: { id: number; name: string }) => ({
      wrapperType: "artist",
      artistType: "Artist",
      artistName: a.name,
      artistId: a.id,
    });
    const albumRow = (id: number) => {
      const on = songs.filter((s) => s.albumId === id);
      return {
        wrapperType: "collection",
        collectionType: "Album",
        collectionId: id,
        collectionName: on[0]?.albumName ?? `Album ${id}`,
        artistId: on[0]?.artistId,
        trackCount: on.length,
        releaseDate: on[0]?.releaseDate,
      };
    };

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
      const term = (url.searchParams.get("term") ?? "").toLowerCase();
      if (url.searchParams.get("entity") === "musicArtist") {
        const found = (options.artists ?? []).filter((a) => a.name.toLowerCase().includes(term));
        return json({ resultCount: found.length, results: found.map(artistRow) });
      }
      if (url.searchParams.get("attribute") === "artistTerm") {
        // An artist's songs, in the order the list has them (Apple's is roughly by popularity).
        const found = songs.filter((s) => s.artist.toLowerCase().includes(term));
        return json({ resultCount: found.length, results: found.map(song) });
      }
      const words = (url.searchParams.get("term") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      // Like Apple, match loosely: every word of the title, and any word of the artist.
      const hits = songs.filter((s) => {
        const title = s.title.toLowerCase().replace(/\(.*?\)/g, "").split(/\s+/).filter(Boolean);
        return title.every((w) => words.includes(w));
      });
      return json({ resultCount: hits.length, results: hits.map(song) });
    }
    if (url.pathname === "/lookup") {
      const ids = (url.searchParams.get("id") ?? "").split(",").map(Number);
      const artist = (options.artists ?? []).find((a) => a.id === ids[0]);
      if (artist) {
        // An artist, and with entity=album everything filed under them plus their appearances.
        const own = [...new Set(songs.filter((s) => s.artistId === artist.id && s.albumId).map((s) => s.albumId!))];
        const albums =
          url.searchParams.get("entity") === "album"
            ? [
                ...own.map(albumRow),
                ...(options.appearsOn?.[artist.id] ?? []).map((a) => ({
                  wrapperType: "collection",
                  collectionType: "Album",
                  collectionId: a.id,
                  collectionName: a.name,
                  artistId: a.artistId,
                  trackCount: 12,
                })),
              ]
            : [];
        return json({ resultCount: 1 + albums.length, results: [artistRow(artist), ...albums] });
      }
      if (songs.some((s) => s.albumId === ids[0])) {
        stats.albumLookups++;
        const on = songs.filter((s) => s.albumId === ids[0]);
        return json({ resultCount: 1 + on.length, results: [albumRow(ids[0]), ...on.map(song)] });
      }
      stats.lookups++;
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
