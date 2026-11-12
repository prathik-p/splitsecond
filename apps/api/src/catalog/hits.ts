import { songKey } from "@splitsecond/shared";
import type { DeezerPlaylist, DeezerTrack } from "../deezer/deezer-client";

/**
 * Building a "hits by year" pool from Deezer.
 *
 * Deezer has no chart-by-year endpoint, so each year's hits are taken from
 * public playlists named after that year ("Hits 2005", "Top 2005", ...). One
 * playlist is one person's opinion; a song that appears in several is a safer
 * bet, so songs are ranked by how many playlists agree, then by popularity.
 */

export const playlistQueries = (year: number) => [`hits ${year}`, `top ${year}`, `best of ${year}`, `${year} hits`];

/**
 * Is this playlist about exactly this year? "Top Hits 2005" yes;
 * "2000s Hits", "Hits 2000-2010" and "2005 vs 2015" no.
 */
export function isPlaylistForYear(playlist: Pick<DeezerPlaylist, "title" | "nb_tracks">, year: number): boolean {
  if (playlist.nb_tracks < 20) return false;
  const title = playlist.title;
  const years = title.match(/(?<!\d)(?:19|20)\d{2}(?!\d)/g) ?? [];
  if (years.length !== 1 || Number(years[0]) !== year) return false;
  // "2000s" / "2000's" is a decade, not a year.
  if (new RegExp(`${year}\\s*'?s\\b`, "i").test(title)) return false;
  return true;
}

export interface Candidate {
  track: DeezerTrack;
  key: string;
  year: number;
  /** How many of the year's playlists contain the song. */
  votes: number;
}

/**
 * Turn each year's playlists into a ranked list of songs. A song that shows up
 * under several years is kept only for the year where most playlists list it
 * (the earliest on a tie), so "best of" lists don't pull hits into later years.
 */
export function rankCandidates(playlistsByYear: Map<number, DeezerTrack[][]>): Map<number, Candidate[]> {
  const best = new Map<string, Candidate>();
  for (const year of [...playlistsByYear.keys()].sort((a, b) => a - b)) {
    const forYear = new Map<string, Candidate>();
    for (const playlist of playlistsByYear.get(year)!) {
      const inThisPlaylist = new Set<string>();
      for (const track of playlist) {
        if (!track?.preview || track.readable === false || !track.artist?.name) continue;
        const key = songKey(track.title_short ?? track.title, track.artist.name);
        const seen = forYear.get(key);
        if (!seen) {
          forYear.set(key, { track, key, year, votes: 1 });
          inThisPlaylist.add(key);
          continue;
        }
        if (!inThisPlaylist.has(key)) {
          seen.votes++;
          inThisPlaylist.add(key);
        }
        if (track.rank > seen.track.rank) seen.track = track;
      }
    }
    for (const candidate of forYear.values()) {
      const current = best.get(candidate.key);
      if (!current || candidate.votes > current.votes) best.set(candidate.key, candidate);
    }
  }

  const out = new Map<number, Candidate[]>();
  for (const year of playlistsByYear.keys()) out.set(year, []);
  for (const candidate of best.values()) out.get(candidate.year)!.push(candidate);
  for (const list of out.values()) list.sort((a, b) => b.votes - a.votes || b.track.rank - a.track.rank);
  return out;
}

/**
 * Does the track's release date fit the year it is claimed as a hit for?
 * Allows a song released late one year to peak the next, and rejects oldies
 * and later remasters that drift into loosely curated playlists. Tracks with
 * no usable date get the benefit of the doubt.
 */
export function releaseFitsYear(releaseDate: string | undefined, year: number): boolean {
  const released = Number(releaseDate?.slice(0, 4));
  if (!released || released < 1900) return true;
  return released >= year - 2 && released <= year + 1;
}
