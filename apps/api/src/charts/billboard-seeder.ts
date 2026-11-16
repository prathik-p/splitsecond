import type { PrismaClient, Track } from "@prisma/client";
import { normalizeArtist, songKey } from "@splitsecond/shared";
import type { Catalog, CatalogTrack } from "../catalog/types";
import { findMatches } from "../catalog/match";
import { isAlternateTrack } from "./release-rules";
import type { ChartEntry, WikipediaCharts } from "./wikipedia-charts";

export interface BillboardOptions {
  fromYear: number;
  toYear: number;
  /** How far down each year's chart to go (1 to 100). */
  perYear: number;
  log?: (message: string) => void;
}

export interface BillboardResult {
  /** Songs in the pool from these charts when the seed finished. */
  saved: number;
  /** Chart entries the catalog had no playable match for. */
  missed: number;
  byYear: Record<number, number>;
  /** Years whose chart couldn't be read this time (not the same as not published yet). */
  unread: number[];
  /** Chart entries not reached because the catalog kept refusing lookups; a re-run continues with them. */
  remaining: number;
}

/**
 * Does a release date fit the year a song was a hit? Allows a song released late
 * one year to peak the next, and rejects later re-recordings and live cuts. A
 * missing date gets the benefit of the doubt.
 */
export function releaseFitsYear(releaseDate: string | undefined, year: number): boolean {
  const released = Number(releaseDate?.slice(0, 4));
  if (!released || released < 1900) return true;
  return released >= year - 2 && released <= year + 1;
}

/** Chart position as a popularity rank (higher is easier). */
export const rankForPosition = (position: number) => Math.max(1, 101 - position) * 10_000;

/** The part of a chart credit to search for: "Usher featuring Lil Jon and Ludacris" → "Usher". */
export function leadArtist(credit: string): string {
  return credit.split(/\s+(?:featuring|feat\.?|ft\.?|with|and|vs\.?)\s+|\s*[&,/]\s*/i)[0].trim() || credit;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/** "P!nk" vs "Pink", "Ke$ha" vs "Kesha": the same once symbols are dropped, give or take a letter. */
function nearlySameArtist(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => normalizeArtist(v).replace(/ /g, ""));
  // The title has to match too, so a one-letter slip on a short name is a safe bet.
  return Math.min(x.length, y.length) >= 3 && Math.max(x.length, y.length) >= 4 && editDistance(x, y) <= 1;
}

/** The catalog track for a chart entry: right title and artist, ideally released around that year. */
export function chooseForEntry(entry: ChartEntry, year: number, found: CatalogTrack[]): CatalogTrack | null {
  // Never a live, livestream or remix version, judged by title and by album.
  const candidates = found.filter((c) => !isAlternateTrack(c));
  const lead = leadArtist(entry.artist);
  let matches = findMatches(entry.title, entry.artist, candidates);
  if (matches.length === 0) matches = findMatches(entry.title, lead, candidates);
  if (matches.length === 0) {
    matches = candidates.filter(
      (c) => findMatches(entry.title, c.artist, [c]).length > 0 && nearlySameArtist(lead, c.artist),
    );
  }
  // A hit of 2005 should be the 2005 recording, not a later re-recording or live cut,
  // but an odd release date shouldn't lose the song.
  return matches.find((c) => releaseFitsYear(c.releaseDate ?? undefined, year)) ?? matches[0] ?? null;
}

/**
 * Fill the default pool with each year's Billboard Year-End hits, matched to a
 * catalog with previews. Works down the charts one position at a time across
 * all years, so stopping early still leaves an even spread. Safe to re-run:
 * entries already saved are skipped without a lookup.
 */
export async function seedBillboard(
  prisma: PrismaClient,
  catalog: Catalog,
  charts: WikipediaCharts,
  options: BillboardOptions,
): Promise<BillboardResult> {
  const { fromYear, toYear, perYear, log = () => {} } = options;

  const queue: { year: number; entry: ChartEntry }[] = [];
  const lists = new Map<number, ChartEntry[]>();
  const unread: number[] = [];
  for (let year = fromYear; year <= toYear; year++) {
    let list: ChartEntry[] = [];
    try {
      list = await charts.yearEnd(year);
      if (list.length === 0) log(`${year}: no year-end chart published yet`);
    } catch (err) {
      unread.push(year);
      log(`${year}: couldn't read the chart (${(err as Error).message})`);
    }
    lists.set(year, list.filter((e) => e.position <= perYear));
  }
  for (let position = 1; position <= perYear; position++) {
    for (const [year, list] of lists) {
      const entry = list.find((e) => e.position === position);
      if (entry) queue.push({ year, entry });
    }
  }

  const byYear: Record<number, number> = {};
  for (let year = fromYear; year <= toYear; year++) byYear[year] = 0;
  let missed = 0;
  let checked = 0;
  let remaining = 0;
  log(`${queue.length} chart entries to check`);

  for (const { year, entry } of queue) {
    checked++;
    const reference = `${year}:${entry.position}`;
    const done = await prisma.trackSource.findFirst({ where: { kind: "billboard", reference } });
    if (done) {
      byYear[year]++;
      continue;
    }

    const rank = rankForPosition(entry.position);
    let track: Track | null = await prisma.track.findFirst({
      where: { songKey: songKey(entry.title, entry.artist) },
      orderBy: { rank: "desc" },
    });

    if (!track) {
      let hit: CatalogTrack | null = null;
      try {
        hit = chooseForEntry(entry, year, await catalog.search(entry.title, leadArtist(entry.artist)));
      } catch (err) {
        log(`"${entry.title}" by ${entry.artist}: lookup failed (${(err as Error).message})`);
        if ((err as { rateLimited?: boolean }).rateLimited) {
          // The catalog has refused through every retry. More lookups would only prolong it.
          remaining = queue.length - checked + 1;
          break;
        }
      }
      if (!hit) {
        missed++;
        continue;
      }
      track =
        (await prisma.track.findFirst({ where: { OR: [{ itunesId: BigInt(hit.id) }, { songKey: songKey(hit.title, hit.artist) }] } })) ??
        (await prisma.track.create({
          data: {
            itunesId: BigInt(hit.id),
            title: hit.title,
            artist: hit.artist,
            album: hit.album,
            coverUrl: hit.coverUrl,
            previewUrl: hit.previewUrl,
            genre: hit.genre ?? null,
            rank,
            year,
            songKey: songKey(hit.title, hit.artist),
            inPool: true,
          },
        }));
    }

    // A song on two years' charts keeps its first year and its best position.
    await prisma.track.update({
      where: { id: track.id },
      data: {
        inPool: true,
        catalogOnly: false, // a chart entry makes it a hit, however it first got here
        year: Math.min(track.year ?? year, year),
        rank: Math.max(track.rank, rank),
      },
    });
    await prisma.trackSource.create({ data: { trackId: track.id, kind: "billboard", reference } });
    byYear[year]++;

    if (checked % 25 === 0) {
      const saved = Object.values(byYear).reduce((a, b) => a + b, 0);
      log(`${checked} of ${queue.length} checked, ${saved} in the pool, down to position ${entry.position}`);
    }
  }

  return { saved: Object.values(byYear).reduce((a, b) => a + b, 0), missed, byYear, unread, remaining };
}
