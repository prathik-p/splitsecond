import { normalizeArtist, normalizeTitle } from "@splitsecond/shared";
import type { CatalogTrack } from "../catalog/types";

/**
 * The catalog tracks that are the same song as a title + artist from another
 * source, in the order given. Titles must match after normalising, and the
 * artists must be the same act (see sameArtist).
 * Tracks without a playable preview are left out.
 */
export function findMatches(title: string, artist: string, candidates: CatalogTrack[]): CatalogTrack[] {
  const wantTitle = normalizeTitle(title);
  if (!wantTitle || !artist.trim()) return [];
  return candidates.filter((c) => {
    if (!c.playable) return false;
    const titles = [c.title, c.altTitle].filter((t): t is string => !!t).map(normalizeTitle);
    return titles.includes(wantTitle) && sameArtist(artist, c.artist);
  });
}

/** The best match: the most popular one, or the first where popularity is unknown. */
export function pickMatch(title: string, artist: string, candidates: CatalogTrack[]): CatalogTrack | null {
  let best: CatalogTrack | null = null;
  for (const c of findMatches(title, artist, candidates)) {
    if (!best || c.rank > best.rank) best = c;
  }
  return best;
}

const JOINERS = /\s*(?:,|&|\+|\/|\band\b|\bwith\b|\bx\b|\bvs\.?(?=\s)|\bfeat\.?(?=\s)|\bft\.?(?=\s)|\bfeaturing\b)\s*/i;

/** An artist credit as its whole normalised name plus the individual acts in it. */
function credit(raw: string) {
  const clean = (v: string) => normalizeArtist(v).replace(/^the /, "");
  const parts = raw.split(JOINERS).map(clean).filter(Boolean);
  return { whole: clean(raw), parts, lead: parts[0] ?? "" };
}

/**
 * Same act, allowing for how services credit collaborations: "Queen" matches
 * "Queen & David Bowie", and "Nelly and Tim McGraw" matches "Nelly". A name that
 * merely contains the other ("Queen Tribute Band") does not.
 */
export function sameArtist(a: string, b: string): boolean {
  const x = credit(a);
  const y = credit(b);
  if (!x.whole || !y.whole) return false;
  return x.whole === y.whole || x.lead === y.lead || y.parts.includes(x.whole) || x.parts.includes(y.whole);
}
