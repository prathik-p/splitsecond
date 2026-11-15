/**
 * A music service the game can search and play previews from. Deezer and
 * Apple's iTunes Search API both fit; which one is used is set by
 * MUSIC_PROVIDER, because Deezer doesn't serve every country.
 */
export type Provider = "deezer" | "itunes";

export interface CatalogTrack {
  provider: Provider;
  /** The provider's id for the track. */
  id: string;
  title: string;
  /** Other spellings of the title to match against (Deezer's title_short). */
  altTitle?: string;
  artist: string;
  album: string | null;
  coverUrl: string | null;
  /** Popularity, higher is better known. 0 if the provider doesn't say. */
  rank: number;
  isrc: string | null;
  /** The provider's genre name, where it gives one (iTunes does). */
  genre?: string | null;
  /** "YYYY-MM-DD" (possibly longer), or null. */
  releaseDate: string | null;
  previewUrl: string | null;
  /** Has a preview that can be played. */
  playable: boolean;
}

export interface Catalog {
  readonly provider: Provider;
  /** Candidates for a song, best first. */
  search(title: string, artist: string): Promise<CatalogTrack[]>;
  /** Full details for one track (adds the ISRC on Deezer). null if it no longer exists. */
  track(id: string): Promise<CatalogTrack | null>;
}
