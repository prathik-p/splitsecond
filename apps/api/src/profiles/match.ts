import { normalizeArtist, normalizeTitle } from "@splitsecond/shared";
import type { DeezerTrack } from "../deezer/deezer-client";

/**
 * Pick the Deezer track that is the same song as a title + artist from another
 * service. Titles must match after normalising; artists must match or one must
 * contain the other ("Queen" vs "Queen & David Bowie"). Among matches, the most
 * popular release with a playable preview wins.
 */
export function pickMatch(title: string, artist: string, candidates: DeezerTrack[]): DeezerTrack | null {
  const wantTitle = normalizeTitle(title);
  const wantArtist = normalizeArtist(artist);
  if (!wantTitle || !wantArtist) return null;

  let best: DeezerTrack | null = null;
  for (const c of candidates) {
    if (!c.preview || c.readable === false) continue;
    const titles = [c.title_short, c.title].filter((t): t is string => !!t).map(normalizeTitle);
    if (!titles.includes(wantTitle)) continue;
    if (!sameArtist(wantArtist, normalizeArtist(c.artist?.name ?? ""))) continue;
    if (!best || c.rank > best.rank) best = c;
  }
  return best;
}

function sameArtist(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // Whole-word containment, so "Air" doesn't match "Fairport Convention".
  return ` ${long} `.includes(` ${short} `);
}
