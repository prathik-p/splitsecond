import { BadGatewayException, Injectable, Logger } from "@nestjs/common";
import type { Track } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { DeezerClient } from "../deezer/deezer-client";
import { DeezerCatalog } from "../deezer/deezer-catalog";
import { ItunesClient } from "../itunes/itunes-client";
import { sliceMp3 } from "../audio/mp3";
import { sliceM4a } from "../audio/m4a";
import type { Catalog, Provider } from "./types";

export interface Clip {
  data: Buffer;
  contentType: string;
}

interface CacheEntry {
  file: Buffer;
  source: Provider;
  expiresAt: number;
}

export function activeProvider(): Provider {
  return process.env.MUSIC_PROVIDER?.toLowerCase() === "deezer" ? "deezer" : "itunes";
}

/**
 * The music service in use, plus preview audio for stored tracks.
 *
 * Preview files are cached in memory for a few minutes, so a player dragging
 * the scrubber several times in a round costs one download.
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);
  readonly provider = activeProvider();
  readonly deezer = new DeezerClient(process.env.DEEZER_API_BASE || undefined);
  readonly itunes = new ItunesClient({
    baseUrl: process.env.ITUNES_API_BASE || undefined,
    country: process.env.ITUNES_COUNTRY || undefined,
    perMinute: Number(process.env.ITUNES_PER_MINUTE) || undefined,
  });
  /** Where new songs are searched for. */
  readonly catalog: Catalog = this.provider === "deezer" ? new DeezerCatalog(this.deezer) : this.itunes;

  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CacheEntry>>();
  private readonly ttlMs = 10 * 60_000;
  private readonly maxEntries = 64;

  constructor(private readonly prisma: PrismaService) {}

  /** The first `seconds` of a track's preview (Infinity for all of it), cut on frame boundaries. */
  async clip(track: Track, seconds: number): Promise<Clip> {
    const entry = await this.file(track);
    if (entry.source === "itunes") {
      // Always re-wrapped as ADTS, so the browser gets one format whatever the length.
      return { data: sliceM4a(entry.file, seconds).aac, contentType: "audio/aac" };
    }
    return {
      data: Number.isFinite(seconds) ? sliceMp3(entry.file, seconds).mp3 : entry.file,
      contentType: "audio/mpeg",
    };
  }

  private async file(track: Track): Promise<CacheEntry> {
    const hit = this.cache.get(track.id);
    if (hit && hit.expiresAt > Date.now()) {
      // Refresh its place in the LRU order.
      this.cache.delete(track.id);
      this.cache.set(track.id, hit);
      return hit;
    }
    const pending = this.inFlight.get(track.id);
    if (pending) return pending;

    const download = this.download(track)
      .then((entry) => {
        this.cache.set(track.id, entry);
        while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value as string);
        return entry;
      })
      .catch((err) => {
        this.logger.warn(`Preview for "${track.title}" failed: ${err instanceof Error ? err.message : err}`);
        throw new BadGatewayException("Couldn't load this song's audio. Try again in a moment.");
      })
      .finally(() => this.inFlight.delete(track.id));
    this.inFlight.set(track.id, download);
    return download;
  }

  private async download(track: Track): Promise<CacheEntry> {
    const expiresAt = Date.now() + this.ttlMs;
    // A track can have ids on both services; prefer the one in use.
    const useItunes = track.itunesId !== null && (this.provider === "itunes" || track.deezerId === null);
    if (useItunes) return { file: await this.itunesPreview(track), source: "itunes", expiresAt };
    if (track.deezerId !== null) {
      return { file: await this.deezer.previewMp3(track.deezerId), source: "deezer", expiresAt };
    }
    throw new Error("Track has no audio source");
  }

  private async itunesPreview(track: Track): Promise<Buffer> {
    if (track.previewUrl) {
      const res = await fetch(track.previewUrl).catch(() => null);
      if (res?.ok) return Buffer.from(await res.arrayBuffer());
    }
    // The stored URL is missing or stale: ask Apple for the current one.
    const fresh = await this.itunes.track(String(track.itunesId));
    if (!fresh?.previewUrl) throw new Error("iTunes no longer offers a preview");
    await this.prisma.track.update({ where: { id: track.id }, data: { previewUrl: fresh.previewUrl } });
    const res = await fetch(fresh.previewUrl);
    if (!res.ok) throw new Error(`Preview download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
