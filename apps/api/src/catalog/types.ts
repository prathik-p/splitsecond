/** A song as Apple's iTunes Search API describes it. */
export interface CatalogTrack {
  /** Apple's track id. */
  id: string;
  title: string;
  artist: string;
  album: string | null;
  coverUrl: string | null;
  /** Popularity, higher is better known. 0 where Apple doesn't say. */
  rank: number;
  /** Length of the whole song in milliseconds, where Apple says. */
  durationMs?: number | null;
  /** Apple's genre name ("Pop", "Hip-Hop/Rap"). */
  genre?: string | null;
  /** "YYYY-MM-DD" (possibly longer), or null. */
  releaseDate: string | null;
  previewUrl: string | null;
  /** Has a preview that can be played. */
  playable: boolean;
}

/** Where songs are searched for: the iTunes client, or a stand-in in tests. */
export interface Catalog {
  /** Candidates for a song, best first. */
  search(title: string, artist: string, limit?: number): Promise<CatalogTrack[]>;
  /** Full details for one track. null if it no longer exists. */
  track(id: string): Promise<CatalogTrack | null>;
}
