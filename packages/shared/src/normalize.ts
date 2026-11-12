/**
 * Normalise a song title for matching: lower case, no accents, and without
 * the decorations that differ between releases of the same song, like
 * "(feat. X)", "- Remastered 2011", "[Radio Edit]" or "(Live)".
 */
const DECORATION =
  /\b(feat\.?|ft\.?|featuring|with|remaster(ed)?|radio edit|single version|album version|edit|mono|stereo|version|live|mix|remix|original|explicit|clean|deluxe|bonus track|from)\b/i;

export function normalizeTitle(title: string): string {
  let t = title.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  // Drop bracketed parts that look like release decorations, keep others ("(I Can't Get No) Satisfaction").
  t = t.replace(/\s*[([]([^)\]]*)[)\]]/g, (whole, inner: string) => (DECORATION.test(inner) ? "" : ` ${inner} `));
  // Drop " - Remastered 2009" style suffixes.
  t = t.replace(/\s+-\s+(.*)$/, (whole, tail: string) => (DECORATION.test(tail) ? "" : whole));
  // Drop trailing "feat. X" without brackets.
  t = t.replace(/\s+(feat\.?|ft\.?|featuring)\s.*$/i, "");
  return t
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeArtist(artist: string): string {
  return normalizeTitle(artist);
}

/** Two tracks count as the same song if title and main artist match after normalising. */
export function songKey(title: string, artist: string): string {
  return `${normalizeTitle(title)}::${normalizeArtist(artist)}`;
}
