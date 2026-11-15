import type { PrismaClient } from "@prisma/client";
import { normalizeArtist, normalizeTitle, songKey } from "@splitsecond/shared";
import type { CatalogTrack } from "../catalog/types";
import type { ItunesAlbum, ItunesArtist, ItunesClient } from "../itunes/itunes-client";
import { sameArtist } from "../profiles/match";

/**
 * Adds the whole catalogue of chosen artists to the pool: every album, EP and
 * single Apple files under the artist, one song per song however many
 * releases it has. These songs are marked catalogOnly, so they come up only
 * when their artist is picked in the run options.
 *
 * Safe to stop and re-run: albums already read are remembered, so a later seed
 * only reads new releases.
 */

export interface ArtistSeedResult {
  /** Artists read this time (including ones already up to date). */
  artists: number;
  /** Songs added to the pool this time. */
  added: number;
  /** Lines of the file no artist was found for. */
  notFound: string[];
  /** True if Apple kept refusing lookups and the rest was left for the next seed. */
  stopped: boolean;
}

/** The artists file: one artist per line. Blank lines and anything after # are ignored. */
export function parseArtistsFile(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    out.push(line);
  }
  return out;
}

/** An Apple artist id, if the line is one or is an Apple Music artist link. */
export function artistIdFromLine(line: string): string | null {
  if (/^\d+$/.test(line)) return line;
  return /^https?:\/\/(?:music|itunes)\.apple\.com\/.*\/artist\/(?:[^/]+\/)?(?:id)?(\d+)/i.exec(line)?.[1] ?? null;
}

const actKey = (name: string) => normalizeArtist(name).replace(/^the /, "");

/** Recordings that aren't the song itself. */
const NOT_A_SONG = /\b(commentary|voice memo|interview|karaoke|instrumental|a\s?cappella|track by track|spoken word)\b/i;
/** Shorter than this is an interlude or a skit. */
const MIN_SONG_MS = 60_000;

/** A title with nothing bolted on: no "(Live)", "(Remix)", "- Remastered", "(feat. X)". */
function isPlain(title: string): boolean {
  const bare = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return bare === normalizeTitle(title);
}

const yearOf = (t: CatalogTrack) => Number(t.releaseDate?.slice(0, 4)) || null;

/** Popularity for a catalogue song from where Apple's search lists it; below a top-50 chart hit's rank. */
const rankForListing = (position: number | undefined) =>
  position === undefined ? 10_000 : Math.max(15_000, 500_000 - position * 2_400);

async function resolve(itunes: ItunesClient, line: string): Promise<ItunesArtist | { closest: string[] }> {
  const id = artistIdFromLine(line);
  if (id) return (await itunes.artist(id)) ?? { closest: [] };
  const found = await itunes.findArtists(line);
  return found.find((a) => actKey(a.name) === actKey(line)) ?? { closest: found.slice(0, 3).map((a) => a.name) };
}

export async function seedArtists(
  prisma: PrismaClient,
  itunes: ItunesClient,
  lines: string[],
  options: { log?: (message: string) => void } = {},
): Promise<ArtistSeedResult> {
  const log = options.log ?? (() => {});
  const result: ArtistSeedResult = { artists: 0, added: 0, notFound: [], stopped: false };

  try {
    for (const line of lines) {
      const query = line.toLowerCase();
      let row = await prisma.artistImport.findFirst({ where: { query } });
      if (!row) {
        const artist = await resolve(itunes, line);
        if ("closest" in artist) {
          result.notFound.push(line);
          log(
            `"${line}": no artist with exactly that name on Apple` +
              (artist.closest.length ? ` (closest: ${artist.closest.join(", ")})` : "") +
              ". Check the spelling, or paste the artist's Apple Music link instead.",
          );
          continue;
        }
        row = await prisma.artistImport.upsert({
          where: { itunesId: BigInt(artist.id) },
          create: { itunesId: BigInt(artist.id), name: artist.name, query },
          update: { query },
        });
      }
      result.artists++;
      result.added += await seedOne(prisma, itunes, { id: String(row.itunesId), name: row.name }, row.albumsDone, log);
    }
  } catch (err) {
    if (!(err as { rateLimited?: boolean }).rateLimited) throw err;
    // Apple has refused through every retry. Everything read so far is saved.
    result.stopped = true;
  }
  return result;
}

async function seedOne(
  prisma: PrismaClient,
  itunes: ItunesClient,
  artist: ItunesArtist,
  albumsDone: string[],
  log: (message: string) => void,
): Promise<number> {
  const reference = artist.id;
  const done = new Set(albumsDone);
  // Albums the artist only appears on are filed under someone else.
  const albums = (await itunes.artistAlbums(artist.id)).filter((a) => a.artistId === null || a.artistId === artist.id);
  const todo = albums.filter((a) => !done.has(a.id)).sort((a, b) => b.trackCount - a.trackCount);
  const have = () => prisma.trackSource.count({ where: { kind: "artist", reference } });
  if (todo.length === 0) {
    log(`${artist.name}: up to date, ${await have()} songs`);
    return 0;
  }
  log(`${artist.name}: reading ${todo.length} ${todo.length === 1 ? "release" : "releases"}…`);

  // Where Apple's search lists each song, as a stand-in for how well known it is.
  const listing = new Map<string, number>();
  for (const t of await itunes.artistSongs(artist.name)) {
    if (!sameArtist(artist.name, t.artist)) continue;
    const key = normalizeTitle(t.title);
    if (!listing.has(key)) listing.set(key, listing.size);
  }

  // Titles already in from this artist, so a single of an album track needn't be read.
  const known = new Set(
    (
      await prisma.trackSource.findMany({ where: { kind: "artist", reference }, select: { track: { select: { title: true } } } })
    ).map((s) => normalizeTitle(s.track.title)),
  );
  const markDone = async (album: ItunesAlbum) => {
    done.add(album.id);
    await prisma.artistImport.update({ where: { itunesId: BigInt(artist.id) }, data: { albumsDone: [...done] } });
  };

  let added = 0;
  let read = 0;
  for (const album of todo) {
    read++;
    const single = album.trackCount <= 1 && known.has(normalizeTitle(album.name.replace(/\s+-\s+(single|ep)$/i, "")));
    if (single) {
      await markDone(album);
      continue;
    }
    let songs: CatalogTrack[];
    try {
      songs = await itunes.albumSongs(album.id);
    } catch (err) {
      if ((err as { rateLimited?: boolean }).rateLimited) throw err;
      log(`  "${album.name}": couldn't be read (${(err as Error).message}); the next seed tries again`);
      continue;
    }
    for (const song of songs) {
      if (!song.playable || NOT_A_SONG.test(song.title)) continue;
      if (song.durationMs != null && song.durationMs < MIN_SONG_MS) continue;
      if (!sameArtist(artist.name, song.artist)) continue;
      if (await save(prisma, song, reference, rankForListing(listing.get(normalizeTitle(song.title))))) added++;
      known.add(normalizeTitle(song.title));
    }
    await markDone(album);
    if (read % 10 === 0 && read < todo.length) log(`  ${read} of ${todo.length} releases read, ${added} songs added`);
  }
  log(`  ${artist.name}: ${added} songs added, ${await have()} in all`);
  return added;
}

/** Add one catalogue song, or fold it into the song already in the pool. Returns true if it is new. */
async function save(prisma: PrismaClient, song: CatalogTrack, reference: string, rank: number): Promise<boolean> {
  const key = songKey(song.title, song.artist);
  const existing = await prisma.track.findFirst({
    where: { OR: [{ itunesId: BigInt(song.id) }, { songKey: key, inPool: true }] },
    orderBy: { rank: "desc" },
  });

  let trackId: string;
  let isNew = false;
  if (!existing) {
    const created = await prisma.track.create({
      data: {
        itunesId: BigInt(song.id),
        title: song.title,
        artist: song.artist,
        album: song.album,
        coverUrl: song.coverUrl,
        previewUrl: song.previewUrl,
        genre: song.genre ?? null,
        rank,
        year: yearOf(song),
        songKey: key,
        inPool: true,
        catalogOnly: true,
      },
    });
    trackId = created.id;
    isNew = true;
  } else {
    trackId = existing.id;
    // In the database from someone's imported profile, but new to the pool.
    isNew = !existing.inPool;
    // Among several releases of a catalogue song, keep the plain original: an untouched
    // title beats "(Live)" or "(Remix)", and the earliest release beats a re-recording.
    const better =
      existing.catalogOnly &&
      existing.itunesId !== BigInt(song.id) &&
      (isPlain(song.title) !== isPlain(existing.title)
        ? isPlain(song.title)
        : (yearOf(song) ?? Infinity) < (existing.year ?? Infinity));
    const taken = better ? await prisma.track.findUnique({ where: { itunesId: BigInt(song.id) } }) : null;
    await prisma.track.update({
      where: { id: existing.id },
      data: {
        inPool: true,
        // A song that was only in someone's imported profile joins the pool as a catalogue song.
        catalogOnly: existing.inPool ? existing.catalogOnly : true,
        genre: existing.genre ?? song.genre ?? null,
        year: existing.year ?? yearOf(song),
        rank: Math.max(existing.rank, rank),
        ...(better && !taken
          ? {
              itunesId: BigInt(song.id),
              title: song.title,
              artist: song.artist,
              album: song.album,
              coverUrl: song.coverUrl,
              previewUrl: song.previewUrl,
              year: yearOf(song),
            }
          : {}),
      },
    });
  }
  await prisma.trackSource.upsert({
    where: { trackId_kind_reference: { trackId, kind: "artist", reference } },
    create: { trackId, kind: "artist", reference },
    update: {},
  });
  return isNew;
}
