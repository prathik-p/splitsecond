import type { PrismaClient } from "@prisma/client";
import { songKey } from "@splitsecond/shared";
import type { DeezerClient, DeezerTrack } from "../deezer/deezer-client";
import { isPlaylistForYear, playlistQueries, rankCandidates, releaseFitsYear } from "./hits";

export interface HitsOptions {
  fromYear: number;
  toYear: number;
  perYear: number;
  /** Playlists to read per year. */
  playlistsPerYear?: number;
  /** Pinned playlist ids per year. A year listed here skips the playlist search. */
  pinned?: Record<string, string[]>;
  log?: (message: string) => void;
}

export interface HitsResult {
  saved: number;
  byYear: Record<number, number>;
}

/** Fill the default pool with the hits of each year. Safe to re-run; it only adds and updates. */
export async function seedHits(prisma: PrismaClient, deezer: DeezerClient, options: HitsOptions): Promise<HitsResult> {
  const { fromYear, toYear, perYear, playlistsPerYear = 6, pinned = {}, log = () => {} } = options;

  // 1. Collect each year's playlists.
  const playlistsByYear = new Map<number, DeezerTrack[][]>();
  for (let year = fromYear; year <= toYear; year++) {
    let ids = pinned[String(year)] ?? [];
    if (ids.length === 0) {
      const found = new Map<number, string>();
      for (const query of playlistQueries(year)) {
        if (found.size >= playlistsPerYear) break;
        const results = await deezer.searchPlaylists(query).catch(() => []);
        for (const p of results) {
          if (found.size >= playlistsPerYear) break;
          if (isPlaylistForYear(p, year)) found.set(p.id, p.title);
        }
      }
      ids = [...found.keys()].map(String);
    }
    const lists: DeezerTrack[][] = [];
    for (const id of ids) {
      const tracks = await deezer.playlistTracks(id, 200).catch(() => []);
      if (tracks.length) lists.push(tracks);
    }
    playlistsByYear.set(year, lists);
    log(`${year}: read ${lists.length} playlist${lists.length === 1 ? "" : "s"}`);
  }

  // 2. Rank, then save the best of each year.
  const ranked = rankCandidates(playlistsByYear);
  const result: HitsResult = { saved: 0, byYear: {} };

  for (let year = fromYear; year <= toYear; year++) {
    const candidates = ranked.get(year) ?? [];
    // Don't chase a full year through an endless tail of weak candidates.
    const budget = candidates.slice(0, perYear * 3);
    // Track ids, so two candidates that turn out to be one recording count once.
    const kept = new Set<string>();

    for (const candidate of budget) {
      if (kept.size >= perYear) break;
      const deezerId = BigInt(candidate.track.id);

      // Already seeded: nothing to look up.
      const existing = await prisma.track.findFirst({
        where: { OR: [{ deezerId }, { songKey: candidate.key, inPool: true }] },
      });
      if (existing) {
        if (existing.year === null || !existing.inPool) {
          await prisma.track.update({ where: { id: existing.id }, data: { year: existing.year ?? year, inPool: true } });
        }
        await tagSource(prisma, existing.id, year);
        kept.add(existing.id);
        continue;
      }

      // The single-track endpoint adds the ISRC and release date.
      const full = await deezer.track(candidate.track.id).catch(() => null);
      if (!full?.preview || full.readable === false) continue;
      if (!releaseFitsYear(full.release_date, year)) continue;

      if (full.isrc) {
        const sameRecording = await prisma.track.findUnique({ where: { isrc: full.isrc } });
        if (sameRecording) {
          await prisma.track.update({
            where: { id: sameRecording.id },
            data: { inPool: true, year: sameRecording.year ?? year },
          });
          await tagSource(prisma, sameRecording.id, year);
          kept.add(sameRecording.id);
          continue;
        }
      }

      const title = full.title_short ?? full.title;
      const created = await prisma.track
        .create({
          data: {
            deezerId,
            isrc: full.isrc ?? null,
            title,
            artist: full.artist.name,
            album: full.album?.title ?? null,
            coverUrl: full.album?.cover_medium ?? null,
            rank: full.rank ?? candidate.track.rank ?? 0,
            year,
            songKey: songKey(title, full.artist.name),
            inPool: true,
          },
        })
        .catch(() => null);
      if (!created) continue;
      await tagSource(prisma, created.id, year);
      kept.add(created.id);
    }

    result.byYear[year] = kept.size;
    result.saved += kept.size;
    const shortfall =
      kept.size >= perYear
        ? ""
        : candidates.length === 0
          ? " (no playlists found for this year)"
          : ` (wanted ${perYear}, found ${candidates.length} candidate${candidates.length === 1 ? "" : "s"})`;
    log(`${year}: ${kept.size} song${kept.size === 1 ? "" : "s"}${shortfall}`);
  }
  return result;
}

async function tagSource(prisma: PrismaClient, trackId: string, year: number) {
  const reference = `hits:${year}`;
  await prisma.trackSource.upsert({
    where: { trackId_kind_reference: { trackId, kind: "seed", reference } },
    create: { trackId, kind: "seed", reference },
    update: {},
  });
}
