import type { PrismaClient } from "@prisma/client";
import type { ItunesClient } from "../itunes/itunes-client";

/**
 * Give every iTunes song that has no genre yet the genre Apple lists for it.
 * Lookups go 150 ids at a time, so a whole pool takes a handful of calls.
 * Returns how many songs got a genre and how many Apple had nothing for.
 */
export async function fillGenres(
  prisma: PrismaClient,
  itunes: ItunesClient,
): Promise<{ filled: number; missing: number }> {
  const rows = await prisma.track.findMany({
    where: { itunesId: { not: null }, genre: null },
    select: { itunesId: true },
  });
  const ids = rows.map((r) => String(r.itunesId));
  let filled = 0;
  for (let i = 0; i < ids.length; i += 150) {
    const byGenre = new Map<string, bigint[]>();
    for (const t of await itunes.tracks(ids.slice(i, i + 150))) {
      if (!t.genre) continue;
      byGenre.set(t.genre, [...(byGenre.get(t.genre) ?? []), BigInt(t.id)]);
    }
    for (const [genre, itunesIds] of byGenre) {
      const done = await prisma.track.updateMany({ where: { itunesId: { in: itunesIds }, genre: null }, data: { genre } });
      filled += done.count;
    }
  }
  return { filled, missing: ids.length - filled };
}
