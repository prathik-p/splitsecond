import { Injectable, Logger } from "@nestjs/common";
import { DeezerClient } from "./deezer-client";

interface CacheEntry {
  mp3: Buffer;
  expiresAt: number;
}

/**
 * Wraps the Deezer client with a small in-memory cache of preview MP3s, so a
 * player dragging the scrubber several times in a round costs one download.
 */
@Injectable()
export class DeezerService {
  private readonly logger = new Logger(DeezerService.name);
  readonly client = new DeezerClient(process.env.DEEZER_API_BASE || "https://api.deezer.com");
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<Buffer>>();
  private readonly ttlMs = 10 * 60_000;
  private readonly maxEntries = 64;

  async preview(deezerId: bigint): Promise<Buffer> {
    const key = deezerId.toString();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      // Refresh LRU position.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.mp3;
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const p = this.client
      .previewMp3(deezerId)
      .then((mp3) => {
        this.cache.set(key, { mp3, expiresAt: Date.now() + this.ttlMs });
        while (this.cache.size > this.maxEntries) {
          this.cache.delete(this.cache.keys().next().value as string);
        }
        return mp3;
      })
      .catch((err) => {
        this.logger.warn(`Preview fetch failed for ${key}: ${err instanceof Error ? err.message : err}`);
        throw err;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }
}
