import type { PoolOptions, RunFilters } from "@splitsecond/shared";

export const NO_FILTERS: RunFilters = { genres: [], artists: [] };

const KEY = "splitsecond.options";

/** Lower case and without accents, so "beyonce" finds "Beyoncé". */
export const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** The songs that fit the options. An empty list of genres or artists means any. */
export function matchingSongs(options: PoolOptions, filters: RunFilters): PoolOptions["songs"] {
  const genres = new Set(filters.genres.map((g) => options.genres.indexOf(g)));
  const artists = new Set(filters.artists.map((a) => options.artists.indexOf(a)));
  return options.songs.filter(
    (s) => (genres.size === 0 || genres.has(s.g)) && (artists.size === 0 || s.a.some((a) => artists.has(a))),
  );
}

const part = (names: string[], all: string, many: string) =>
  names.length === 0 ? all : names.length <= 2 ? names.join(", ") : `${names.length} ${many}`;

/** "Pop · All artists", "2 genres · Adele": the lobby's summary of the options. */
export function describeFilters(filters: RunFilters): string {
  return `${part(filters.genres, "All genres", "genres")} · ${part(filters.artists, "All artists", "artists")}`;
}

/** Only what was chosen ("Pop", "Pop · Adele"), or null when nothing was. */
export function describeChosen(filters: RunFilters): string | null {
  const chosen = [part(filters.genres, "", "genres"), part(filters.artists, "", "artists")].filter(Boolean);
  return chosen.length ? chosen.join(" · ") : null;
}

export const isFiltered = (filters: RunFilters) => filters.genres.length > 0 || filters.artists.length > 0;

/** A stable name for a set of options, used to keep a personal best for each. */
export function filtersKey(filters: RunFilters): string {
  if (!isFiltered(filters)) return "hits";
  const list = (names: string[]) => [...names].map(fold).sort().join("|");
  return `hits/g:${list(filters.genres)}/a:${list(filters.artists)}`;
}

/** The options chosen last time, without any genre or artist the pool no longer has. */
export function loadFilters(options: PoolOptions): RunFilters {
  try {
    const saved = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as Partial<RunFilters> | null;
    const keep = (names: unknown, known: string[]) =>
      Array.isArray(names) ? names.filter((n): n is string => typeof n === "string" && known.includes(n)) : [];
    return { genres: keep(saved?.genres, options.genres), artists: keep(saved?.artists, options.artists) };
  } catch {
    return NO_FILTERS;
  }
}

export function saveFilters(filters: RunFilters) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(filters));
  } catch {
    // private mode: the choice just isn't remembered
  }
}
