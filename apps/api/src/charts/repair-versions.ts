import type { PrismaClient, Track } from "@prisma/client";
import type { Catalog, CatalogTrack } from "../catalog/types";
import { releaseFitsYear } from "../catalog/hits";
import { findMatches } from "../profiles/match";
import { leadArtist } from "./billboard-seeder";
import { isAlternateTrack } from "./release-rules";

/**
 * Finds songs in the pool that are another version (a livestream, live or
 * remix recording, by their title or by the album they come from) and puts
 * that right. A chart hit is swapped for the original recording of the same
 * song; one with no original on the catalog, and any catalogue song, is taken
 * out. Older seeds matched some hits to whatever version came up first.
 */

export interface RepairResult {
  /** Hits now playing the original recording. */
  swapped: number;
  /** Songs taken out of the pool. */
  removed: number;
  /** True if the catalog kept refusing lookups; the next seed continues. */
  stopped: boolean;
}

type Searchable = Pick<Catalog, "provider"> & { search(title: string, artist: string, limit?: number): Promise<CatalogTrack[]> };

/** The title without its brackets and " - …" tail, to search with. */
const searchTitle = (title: string) =>
  title
    .replace(/[([（【][^)\]）】]*(?:[)\]）】]|$)/g, " ")
    .replace(/\s[-–—]\s.*$/, "")
    .replace(/\s+/g, " ")
    .trim() || title;

/** The original recording among search results: same song and artist, not another version, ideally from the hit's year. */
export function originalOf(track: Pick<Track, "title" | "artist" | "year">, candidates: CatalogTrack[]): CatalogTrack | null {
  const clean = candidates.filter((c) => !isAlternateTrack(c));
  const title = searchTitle(track.title);
  let matches = findMatches(title, track.artist, clean);
  if (matches.length === 0) matches = findMatches(title, leadArtist(track.artist), clean);
  const year = track.year;
  return (year ? matches.find((c) => releaseFitsYear(c.releaseDate ?? undefined, year)) : undefined) ?? matches[0] ?? null;
}

export async function repairVersions(
  prisma: PrismaClient,
  catalog: Searchable,
  options: { log?: (message: string) => void } = {},
): Promise<RepairResult> {
  const log = options.log ?? (() => {});
  const result: RepairResult = { swapped: 0, removed: 0, stopped: false };
  const pool = await prisma.track.findMany({ where: { inPool: true } });
  const wrong = pool.filter(isAlternateTrack);
  if (wrong.length === 0) return result;
  log(`${wrong.length} ${wrong.length === 1 ? "song is" : "songs are"} another version (live, livestream, remix…); fixing`);

  for (const track of wrong) {
    if (track.catalogOnly) {
      await retire(prisma, track);
      result.removed++;
      continue;
    }
    let original: CatalogTrack | null = null;
    try {
      original = originalOf(track, await catalog.search(searchTitle(track.title), leadArtist(track.artist), 25));
    } catch (err) {
      if ((err as { rateLimited?: boolean }).rateLimited) {
        result.stopped = true;
        break;
      }
      log(`"${track.title}": lookup failed (${(err as Error).message}); the next seed tries again`);
      continue;
    }
    if (!original) {
      await retire(prisma, track);
      result.removed++;
      log(`"${track.title}" by ${track.artist} (${track.album}): no original recording found, taken out`);
      continue;
    }
    await swap(prisma, track, original, catalog.provider);
    result.swapped++;
    log(`"${track.title}" by ${track.artist}: now the original from "${original.album}" instead of "${track.album}"`);
  }
  return result;
}

/** Point a hit at the original recording, or merge it into the row that already holds it. */
async function swap(prisma: PrismaClient, track: Track, original: CatalogTrack, provider: Catalog["provider"]) {
  const idField = provider === "deezer" ? { deezerId: BigInt(original.id) } : { itunesId: BigInt(original.id) };
  const holder = await prisma.track.findFirst({ where: { ...idField, id: { not: track.id } } });
  if (holder) {
    // The original is already saved (say, from an artist catalogue): it takes over as the hit.
    const sources = await prisma.trackSource.findMany({ where: { trackId: track.id } });
    for (const s of sources) {
      await prisma.trackSource.upsert({
        where: { trackId_kind_reference: { trackId: holder.id, kind: s.kind, reference: s.reference } },
        create: { trackId: holder.id, kind: s.kind, reference: s.reference },
        update: {},
      });
    }
    await prisma.track.update({
      where: { id: holder.id },
      data: {
        inPool: true,
        catalogOnly: false,
        rank: Math.max(holder.rank, track.rank),
        year: holder.year && track.year ? Math.min(holder.year, track.year) : (track.year ?? holder.year),
        genre: holder.genre ?? track.genre,
      },
    });
    await retire(prisma, track);
    return;
  }
  await prisma.track.update({
    where: { id: track.id },
    data: {
      ...idField,
      title: original.title,
      artist: original.artist,
      album: original.album,
      coverUrl: original.coverUrl,
      previewUrl: provider === "itunes" ? original.previewUrl : track.previewUrl,
      genre: track.genre ?? original.genre ?? null,
    },
  });
}

/**
 * Take a song out for good: delete it, or, when a played run or an imported
 * profile points at it, keep the row out of the pool under a key no seed will
 * match again, so the next seed finds the original instead.
 */
async function retire(prisma: PrismaClient, track: Track) {
  const deleted = await prisma.track.deleteMany({
    where: { id: track.id, rounds: { none: {} }, guesses: { none: {} }, profiles: { none: {} } },
  });
  if (deleted.count) return;
  await prisma.trackSource.deleteMany({ where: { trackId: track.id } });
  await prisma.track.update({
    where: { id: track.id },
    data: { inPool: false, songKey: `${track.songKey}#other-version` },
  });
}
