import type { PrismaClient } from "@prisma/client";
import { songKey } from "@splitsecond/shared";
import type { ItunesClient } from "../itunes/itunes-client";
import { rankForPosition } from "./billboard-seeder";

/** Apple's "most played" songs right now, as track ids in chart order. */
export async function appleChartIds(feedUrl: string): Promise<string[]> {
  const res = await fetch(feedUrl, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Apple chart HTTP ${res.status}`);
  const body = (await res.json()) as { feed?: { results?: { id?: string }[] } };
  return (body.feed?.results ?? []).map((r) => r.id).filter((id): id is string => !!id && /^\d+$/.test(id));
}

export const APPLE_CHART_URL = "https://rss.applemarketingtools.com/api/v2/us/music/most-played/100/songs.json";

/**
 * Add today's most played songs to the pool. This covers the current year,
 * which has no year-end chart until December. Returns how many are in the pool.
 */
export async function seedAppleChart(
  prisma: PrismaClient,
  itunes: ItunesClient,
  options: { feedUrl?: string; fromYear: number; limit?: number },
): Promise<number> {
  const ids = (await appleChartIds(options.feedUrl ?? APPLE_CHART_URL)).slice(0, options.limit ?? 100);
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
          data: { inPool: true, year: existing.year ?? released, rank: Math.max(existing.rank, rank) },
        })
      : await prisma.track.create({
          data: {
            itunesId: BigInt(t.id),
            title: t.title,
            artist: t.artist,
            album: t.album,
            coverUrl: t.coverUrl,
            previewUrl: t.previewUrl,
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
