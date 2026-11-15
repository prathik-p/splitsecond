import { normalizeArtist, RUN_LENGTH, type PoolOptions, type RunFilters } from "@splitsecond/shared";

/**
 * Run options: the genres and artists a run can be limited to, worked out from
 * the songs in the pool.
 *
 * Artists need some care, because a credit can name several acts ("Calvin Harris
 * & Rihanna") and a featured act often sits in the title ("(feat. Rihanna)").
 * A song counts for every act in its credit or its "feat." that has songs of
 * its own in the pool; a credit is only split when that is clearly right, so
 * "Earth, Wind & Fire" stays one act even if someone called "Fire" has a hit.
 */

export interface OptionTrack {
  title: string;
  artist: string;
  genre: string | null;
  songKey: string;
}

/** Shorter names for Apple's genres where the full one is a mouthful on a chip. */
const GENRE_NAMES: Record<string, string> = {
  "Hip-Hop/Rap": "Hip-Hop",
  "R&B/Soul": "R&B",
  "Singer/Songwriter": "Singer-Songwriter",
};
/** Genres too small to fill a run on their own are shown together under this name. */
export const OTHER_GENRE = "Other";

const JOINERS = /\s*(?:,|&|\+|\/|\band\b|\bwith\b|\bx\b|\bvs\.?(?=\s)|\bfeat\.?(?=\s)|\bft\.?(?=\s)|\bfeaturing\b)\s*/i;
const FEATURED = /[([](?:feat\.?|ft\.?|featuring|with)\s+([^)\]]+)[)\]]/gi;

const artistKey = (name: string) => normalizeArtist(name).replace(/^the /, "");

export interface PoolIndex {
  options: PoolOptions;
  /** The songKey of each entry in options.songs, in the same order. */
  keys: string[];
}

/** One entry per song (not per release), with its genre and the acts it counts for. */
export function buildOptions(tracks: OptionTrack[]): PoolIndex {
  // The pool can hold several releases of a song; the first one seen stands for it.
  const songs = new Map<string, OptionTrack>();
  for (const t of tracks) if (!songs.has(t.songKey)) songs.set(t.songKey, t);

  // Every whole credit is an act, under the spelling it is first seen with.
  const acts = new Map<string, string>();
  for (const t of songs.values()) {
    const key = artistKey(t.artist);
    if (key && !acts.has(key)) acts.set(key, t.artist.trim());
  }

  const genreCount = new Map<string, number>();
  const named = (raw: string | null) => (raw ? (GENRE_NAMES[raw] ?? raw) : null);
  for (const t of songs.values()) {
    const g = named(t.genre);
    if (g) genreCount.set(g, (genreCount.get(g) ?? 0) + 1);
  }
  const big = [...genreCount].filter(([, n]) => n >= RUN_LENGTH).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const genres = big.map(([g]) => g);
  if (genreCount.size > big.length) genres.push(OTHER_GENRE);
  const genreAt = new Map(genres.map((g, i) => [g, i]));

  const artists: string[] = [];
  const artistAt = new Map<string, number>();
  const indexOf = (key: string) => {
    let i = artistAt.get(key);
    if (i === undefined) {
      i = artists.push(acts.get(key)!) - 1;
      artistAt.set(key, i);
    }
    return i;
  };

  const out: PoolOptions["songs"] = [];
  const keys: string[] = [];
  for (const t of songs.values()) {
    const whole = artistKey(t.artist);
    const parts = t.artist.split(JOINERS).map(artistKey).filter(Boolean);
    const known = parts.filter((p) => p !== whole && acts.has(p));
    const split = parts.length > 1 && known.length > 0 && (known.includes(parts[0]) || known.length === parts.length);
    const credited = new Set(split ? known : whole ? [whole] : []);
    for (const match of t.title.matchAll(FEATURED)) {
      for (const guest of match[1].split(JOINERS).map(artistKey)) if (acts.has(guest)) credited.add(guest);
    }
    const g = named(t.genre);
    out.push({ g: g === null ? -1 : (genreAt.get(g) ?? genreAt.get(OTHER_GENRE)!), a: [...credited].map(indexOf) });
    keys.push(t.songKey);
  }
  return { options: { genres, artists, songs: out }, keys };
}

/** Trim a client's run options to clean lists of names. */
export function cleanFilters(genres: unknown, artists: unknown): RunFilters {
  const list = (v: unknown) =>
    Array.isArray(v)
      ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, 120)).filter(Boolean))].slice(0, 100)
      : [];
  return { genres: list(genres), artists: list(artists) };
}

/** The songKeys of the songs that fit the options. No genres means any genre; no artists, any artist. */
export function matchingKeys(index: PoolIndex, filters: RunFilters): Set<string> {
  const { options, keys } = index;
  const genres = new Set(filters.genres.map((g) => options.genres.indexOf(g)));
  const wanted = new Set(filters.artists.map(artistKey));
  const artists = new Set(options.artists.flatMap((name, i) => (wanted.has(artistKey(name)) ? [i] : [])));
  const out = new Set<string>();
  options.songs.forEach((song, i) => {
    if (filters.genres.length && !genres.has(song.g)) return;
    if (filters.artists.length && !song.a.some((a) => artists.has(a))) return;
    out.add(keys[i]);
  });
  return out;
}
