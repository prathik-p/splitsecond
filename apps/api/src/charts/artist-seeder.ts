import type { PrismaClient } from "@prisma/client";
import { normalizeArtist, normalizeTitle, songKey } from "@splitsecond/shared";
import type { CatalogTrack } from "../catalog/types";
import type { ItunesAlbum, ItunesArtist, ItunesClient } from "../itunes/itunes-client";
import { sameArtist } from "../catalog/match";
import { isAlternateRelease, isAlternateTrack, isAlternateVersion } from "./release-rules";

/**
 * Adds the whole catalogue of chosen artists to the pool: the original studio
 * recording of every song on the albums, EPs and singles Apple files under the
 * artist, one entry per song however many releases it has. Remixes, live
 * recordings and other alternate versions are left out (see release-rules.ts).
 * These songs are marked catalogOnly, so they come up only when their artist
 * is picked in the run options.
 *
 * Safe to stop and re-run: albums already read are remembered, so a later seed
 * only reads new releases. An artist taken out of the file has their catalogue
 * taken out of the pool again.
 */

export interface ArtistSeedResult {
  /** Artists read this time (including ones already up to date). */
  artists: number;
  /** Songs added to the pool this time. */
  added: number;
  /** Catalogue songs taken out because their artist is no longer in the file. */
  removed: number;
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

/**
 * Bumped whenever the rules for what gets added change. An artist read under
 * older rules is cleared out and read again, so the pool matches the new rules.
 */
export const RULES_VERSION = 3;
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
  const result: ArtistSeedResult = { artists: 0, added: 0, removed: 0, notFound: [], stopped: false };
  const listed = new Set<bigint>();

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
          create: { itunesId: BigInt(artist.id), name: artist.name, query, rules: RULES_VERSION },
          update: { query },
        });
      }
      result.artists++;
      listed.add(row.itunesId);
      let albumsDone = row.albumsDone;
      if (row.rules !== RULES_VERSION) {
        if (albumsDone.length) log(`${row.name}: reading again, this time without remixes, live versions and the like`);
        await clearArtist(prisma, String(row.itunesId));
        albumsDone = [];
      }
      result.added += await seedOne(prisma, itunes, { id: String(row.itunesId), name: row.name }, albumsDone, log);
    }
    // An artist no longer in the file leaves the pool. Not when a line went unrecognised,
    // though: that may be the same artist with a typo, and re-reading a catalogue is slow.
    if (result.notFound.length === 0) {
      for (const row of await prisma.artistImport.findMany({ where: { itunesId: { notIn: [...listed] } } })) {
        const gone = await clearArtist(prisma, String(row.itunesId));
        await prisma.artistImport.delete({ where: { itunesId: row.itunesId } });
        result.removed += gone;
        log(`${row.name}: no longer in artists.txt, ${gone} ${gone === 1 ? "song" : "songs"} taken out`);
      }
    }
  } catch (err) {
    if (!(err as { rateLimited?: boolean }).rateLimited) throw err;
    // Apple has refused through every retry. Everything read so far is saved.
    result.stopped = true;
  }
  await sweep(prisma);
  return result;
}

/**
 * Take an artist's catalogue songs back out of the pool, so they can be read again
 * under new rules or because the artist left the file. Returns how many left.
 */
async function clearArtist(prisma: PrismaClient, reference: string): Promise<number> {
  const links = await prisma.trackSource.findMany({ where: { kind: "artist", reference }, select: { trackId: true } });
  await prisma.trackSource.deleteMany({ where: { kind: "artist", reference } });
  // Hits stay, and so does a song another listed artist's catalogue also holds (a duet).
  const { count } = await prisma.track.updateMany({
    where: { id: { in: links.map((l) => l.trackId) }, catalogOnly: true, inPool: true, sources: { none: { kind: "artist" } } },
    data: { inPool: false },
  });
  await prisma.artistImport.update({
    where: { itunesId: BigInt(reference) },
    data: { albumsDone: [], rules: RULES_VERSION },
  });
  await sweep(prisma);
  return count;
}

/**
 * Delete catalogue songs that have left the pool, so they don't linger in the
 * database. One that a played run points at has to stay;
 * it just stays out of the pool.
 */
async function sweep(prisma: PrismaClient): Promise<number> {
  const { count } = await prisma.track.deleteMany({
    where: {
      catalogOnly: true,
      inPool: false,
      sources: { none: {} },
      rounds: { none: {} },
      guesses: { none: {} },
    },
  });
  return count;
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

  // Songs already in from this artist, by title. A single of an album track needn't be
  // read, and the same title under a different credit ("X & Y") is the same song.
  const known = new Map(
    (
      await prisma.trackSource.findMany({
        where: { kind: "artist", reference },
        select: { track: { select: { id: true, title: true } } },
      })
    ).map((s) => [normalizeTitle(s.track.title), s.track.id]),
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
    // Live albums, remix EPs and the like hold nothing wanted, so they aren't even fetched.
    if (single || isAlternateRelease(album.name)) {
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
      if (!song.playable || isAlternateVersion(song.title)) continue;
      if (song.durationMs != null && song.durationMs < MIN_SONG_MS) continue;
      if (!sameArtist(artist.name, song.artist)) continue;
      const title = normalizeTitle(song.title);
      const saved = await save(prisma, song, artist, rankForListing(listing.get(title)), known.get(title));
      if (saved.isNew) added++;
      known.set(title, saved.trackId);
    }
    await markDone(album);
    if (read % 10 === 0 && read < todo.length) log(`  ${read} of ${todo.length} releases read, ${added} songs added`);
  }
  log(`  ${artist.name}: ${added} songs added, ${await have()} in all`);
  return added;
}

/**
 * Add one catalogue song, or fold it into the song already there: the same
 * recording, the same song by key, or (sameTitleId) a song of this artist's
 * with the same title.
 */
async function save(
  prisma: PrismaClient,
  song: CatalogTrack,
  artist: ItunesArtist,
  rank: number,
  sameTitleId: string | undefined,
): Promise<{ trackId: string; isNew: boolean }> {
  const reference = artist.id;
  const key = songKey(song.title, song.artist);
  const existing =
    (await prisma.track.findFirst({
      // A song taken out of the pool earlier is reused, not duplicated.
      where: { OR: [{ itunesId: BigInt(song.id) }, { songKey: key }] },
      orderBy: [{ inPool: "desc" }, { rank: "desc" }],
    })) ?? (sameTitleId ? await prisma.track.findUnique({ where: { id: sameTitleId } }) : null);
  /** Credited to the artist alone, rather than as a duet or a guest version. */
  const solo = (credit: string) => actKey(credit) === actKey(artist.name);

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
    // In the database but out of the pool until now.
    isNew = !existing.inPool;
    // Among several releases of a catalogue song, keep the plain original: an untouched
    // title beats "(Remastered)" or "(X's Version)", the artist alone beats a duet version,
    // and the earliest release beats a later one.
    // A saved song that is itself a live or livestream version (a hit matched by an older seed) always gives way.
    const better =
      existing.itunesId !== BigInt(song.id) &&
      (isAlternateTrack(existing) ||
        (existing.catalogOnly &&
          (isPlain(song.title) !== isPlain(existing.title)
            ? isPlain(song.title)
            : solo(song.artist) !== solo(existing.artist)
              ? solo(song.artist)
              : (yearOf(song) ?? Infinity) < (existing.year ?? Infinity))));
    const taken = better ? await prisma.track.findUnique({ where: { itunesId: BigInt(song.id) } }) : null;
    await prisma.track.update({
      where: { id: existing.id },
      data: {
        inPool: true,
        // A song that was out of the pool comes back as a catalogue song.
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
              songKey: key,
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
  return { trackId, isNew };
}
