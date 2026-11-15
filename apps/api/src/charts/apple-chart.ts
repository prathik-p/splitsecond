import type { PrismaClient } from "@prisma/client";
import { songKey } from "@splitsecond/shared";
import type { ItunesClient } from "../itunes/itunes-client";
import { rankForPosition } from "./billboard-seeder";

/** Apple's "most played" songs right now. */
export const APPLE_CHART_URL = "https://rss.applemarketingtools.com/api/v2/us/music/most-played/100/songs.json";
/** The older iTunes "top songs" feed, on the same host as the search API. Used when the first is down. */
export const APPLE_TOP_SONGS_URL = "https://itunes.apple.com/us/rss/topsongs/limit=100/json";

interface FeedBody {
  feed?: {
    /** The marketing-tools feed. */
    results?: { id?: string }[];
    /** The older iTunes feed; a single song comes as an object, not a list. */
    entry?: LegacyEntry | LegacyEntry[];
  };
}
interface LegacyEntry {
  id?: { attributes?: { "im:id"?: string } };
}

/** Track ids in chart order, from either shape of Apple feed. */
export function chartIdsFromFeed(body: FeedBody): string[] {
  const legacy = body.feed?.entry ? [body.feed.entry].flat().map((e) => e.id?.attributes?.["im:id"]) : [];
  const ids = [...(body.feed?.results ?? []).map((r) => r.id), ...legacy];
  return ids.filter((id): id is string => !!id && /^\d+$/.test(id));
}

/** One Apple chart feed as track ids in chart order. */
export async function appleChartIds(feedUrl: string): Promise<string[]> {
  const res = await fetch(feedUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) }).catch(
    (err: Error) => {
      throw new Error(err.name === "TimeoutError" ? "Apple chart didn't answer in 15s" : `Apple chart unreachable (${err.message})`);
    },
  );
  if (!res.ok) throw new Error(`Apple chart HTTP ${res.status}`);
  return chartIdsFromFeed((await res.json()) as FeedBody);
}

/**
 * The current chart from the first feed that answers with songs. Apple's feeds
 * have bad moments, so each is tried twice before moving to the next.
 */
export async function currentChartIds(
  feedUrls: string[] = [APPLE_CHART_URL, APPLE_TOP_SONGS_URL],
  retryMs = 3000,
): Promise<{ ids: string[]; feedUrl: string }> {
  let failure = new Error("no Apple chart feed to read");
  for (const feedUrl of feedUrls) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const ids = await appleChartIds(feedUrl);
        if (ids.length > 0) return { ids, feedUrl };
        failure = new Error("Apple chart came back empty");
        break;
      } catch (err) {
        failure = err as Error;
        if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, retryMs));
      }
    }
  }
  throw failure;
}

/**
 * Add today's most popular songs to the pool. This covers the current year,
 * which has no year-end chart until December. Returns how many are in the pool.
 */
export async function seedAppleChart(
  prisma: PrismaClient,
  itunes: ItunesClient,
  options: { feedUrls?: string[]; fromYear: number; limit?: number; retryMs?: number },
): Promise<number> {
  const chart = await currentChartIds(options.feedUrls?.length ? options.feedUrls : undefined, options.retryMs);
  const ids = chart.ids.slice(0, options.limit ?? 100);
  const position = new Map(ids.map((id, i) => [id, i + 1]));
  const tracks = await itunes.tracks(ids);

  let saved = 0;
  for (const t of tracks) {
    if (!t.playable) continue;
    const released = Number(t.releaseDate?.slice(0, 4)) || null;
    // Old songs do chart again; keep the pool to the range being seeded.
    if (released !== null && released < options.fromYear) continue;
    const key = songKey(t.title, t.artist);
    const rank = rankForPosition(position.get(t.id) ?? 100);
    const existing = await prisma.track.findFirst({ where: { OR: [{ itunesId: BigInt(t.id) }, { songKey: key }] } });
    const track = existing
      ? await prisma.track.update({
          where: { id: existing.id },
          data: {
            inPool: true,
            catalogOnly: false,
            year: existing.year ?? released,
            rank: Math.max(existing.rank, rank),
            genre: existing.genre ?? t.genre ?? null,
          },
        })
      : await prisma.track.create({
          data: {
            itunesId: BigInt(t.id),
            title: t.title,
            artist: t.artist,
            album: t.album,
            coverUrl: t.coverUrl,
            previewUrl: t.previewUrl,
            genre: t.genre ?? null,
            rank,
            year: released,
            songKey: key,
            inPool: true,
          },
        });
    await prisma.trackSource.upsert({
      where: { trackId_kind_reference: { trackId: track.id, kind: "apple-chart", reference: "most-played" } },
      create: { trackId: track.id, kind: "apple-chart", reference: "most-played" },
      update: {},
    });
    saved++;
  }
  return saved;
}
