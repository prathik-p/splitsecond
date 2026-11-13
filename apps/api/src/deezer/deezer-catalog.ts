import type { Catalog, CatalogTrack } from "../catalog/types";
import { DeezerClient, DeezerTrack } from "./deezer-client";

/** Deezer as a Catalog. */
export class DeezerCatalog implements Catalog {
  readonly provider = "deezer" as const;

  constructor(readonly client: DeezerClient) {}

  async search(title: string, artist: string): Promise<CatalogTrack[]> {
    return (await this.client.search(title, artist)).map(fromDeezer);
  }

  async track(id: string): Promise<CatalogTrack | null> {
    return this.client
      .track(Number(id))
      .then(fromDeezer)
      .catch(() => null);
  }
}

export function fromDeezer(track: DeezerTrack): CatalogTrack {
  return {
    provider: "deezer",
    id: String(track.id),
    title: track.title_short ?? track.title,
    altTitle: track.title,
    artist: track.artist?.name ?? "",
    album: track.album?.title ?? null,
    coverUrl: track.album?.cover_medium ?? null,
    rank: track.rank ?? 0,
    isrc: track.isrc ?? null,
    releaseDate: track.release_date ?? null,
    previewUrl: track.preview || null,
    playable: !!track.preview && track.readable !== false,
  };
}
