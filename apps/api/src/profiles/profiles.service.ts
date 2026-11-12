import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma, Profile, Track } from "@prisma/client";
import { ProfileState, songKey } from "@splitsecond/shared";
import { PrismaService } from "../prisma/prisma.service";
import { DeezerService } from "../deezer/deezer.service";
import { LASTFM_USERNAME, LastfmClient, LastfmError, LastfmTrack } from "../lastfm/lastfm-client";
import { pickMatch } from "./match";

const SOURCE = "lastfm";
const LOVED_LIMIT = 100;
/** Lookups run side by side; the Deezer client's rate limiter still caps the request rate. */
const WORKERS = 4;

@Injectable()
export class ProfilesService implements OnModuleInit {
  private readonly logger = new Logger(ProfilesService.name);
  private readonly jobs = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly deezer: DeezerService,
  ) {}

  /** Imports run in this process, so any left "running" by a restart will never finish. */
  async onModuleInit() {
    await this.prisma.profile.updateMany({
      where: { status: { in: ["PENDING", "RUNNING"] } },
      data: { status: "FAILED", error: "The import was interrupted. Try again." },
    });
  }

  async list(): Promise<ProfileState[]> {
    const profiles = await this.prisma.profile.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
    return profiles.map(toState);
  }

  async get(id: string): Promise<ProfileState> {
    const profile = await this.prisma.profile.findUnique({ where: { id } });
    if (!profile) throw new NotFoundException("Profile not found");
    return toState(profile);
  }

  /**
   * Start importing a Last.fm user's top and loved tracks. Returns straight away;
   * poll the profile for progress. An already imported profile is returned as is
   * unless `refresh` is set.
   */
  async importLastfm(rawUsername: unknown, refresh = false): Promise<ProfileState> {
    const username = typeof rawUsername === "string" ? rawUsername.trim() : "";
    if (!LASTFM_USERNAME.test(username)) {
      throw new BadRequestException("That doesn't look like a Last.fm username");
    }
    const where = { source_username: { source: SOURCE, username: username.toLowerCase() } };

    const existing = await this.prisma.profile.findUnique({ where });
    if (existing && (this.jobs.has(existing.id) || (existing.status === "DONE" && !refresh))) {
      return toState(existing);
    }

    const client = this.lastfm();
    let displayName: string;
    try {
      displayName = await client.displayName(username);
    } catch (err) {
      if (err instanceof LastfmError && err.notFound) {
        throw new NotFoundException(`Last.fm has no user called "${username}"`);
      }
      throw new BadGatewayException(`Last.fm didn't answer: ${(err as Error).message}`);
    }

    const reset = { displayName, status: "RUNNING" as const, total: 0, processed: 0, matched: 0, error: null };
    const profile = await this.prisma.profile.upsert({
      where,
      create: { source: SOURCE, username: username.toLowerCase(), ...reset },
      update: reset,
    });

    const job = this.run(profile.id, username, client).finally(() => this.jobs.delete(profile.id));
    this.jobs.set(profile.id, job);
    return toState(profile);
  }

  /** Resolves when the profile's import (if any) has finished. For tests. */
  whenIdle(profileId: string): Promise<void> {
    return this.jobs.get(profileId) ?? Promise.resolve();
  }

  private lastfm(): LastfmClient {
    const key = process.env.LASTFM_API_KEY;
    if (!key) {
      throw new ServiceUnavailableException("Last.fm import isn't set up. Add LASTFM_API_KEY to apps/api/.env.");
    }
    return new LastfmClient(key, process.env.LASTFM_API_BASE || undefined);
  }

  private async run(profileId: string, username: string, client: LastfmClient) {
    try {
      const topLimit = Math.max(1, Number(process.env.LASTFM_TOP_LIMIT) || 200);
      const [top, loved] = await Promise.all([
        client.topTracks(username, topLimit),
        // Loved tracks are a bonus; a failure there shouldn't sink the import.
        client.lovedTracks(username, LOVED_LIMIT).catch(() => [] as LastfmTrack[]),
      ]);

      // One entry per song, however many releases or lists it appears in.
      const wanted = new Map<string, LastfmTrack>();
      for (const t of [...top, ...loved]) {
        const key = songKey(t.title, t.artist);
        const seen = wanted.get(key);
        if (seen) {
          seen.playcount = Math.max(seen.playcount, t.playcount);
          seen.loved ||= t.loved;
        } else {
          wanted.set(key, { ...t });
        }
      }
      await this.prisma.profile.update({ where: { id: profileId }, data: { total: wanted.size } });

      const queue = [...wanted.entries()];
      const kept = new Set<string>();
      let processed = 0;
      let failures = 0;

      const worker = async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          const [key, wantedTrack] = item;
          try {
            const track = await this.resolve(key, wantedTrack);
            if (track) {
              const data = { playcount: wantedTrack.playcount, loved: wantedTrack.loved };
              await this.prisma.profileTrack.upsert({
                where: { profileId_trackId: { profileId, trackId: track.id } },
                create: { profileId, trackId: track.id, ...data },
                update: data,
              });
              kept.add(track.id);
            }
          } catch (err) {
            failures++;
            this.logger.warn(`Couldn't match "${wantedTrack.title}" by ${wantedTrack.artist}: ${(err as Error).message}`);
          }
          processed++;
          if (processed % 5 === 0) {
            await this.prisma.profile.update({
              where: { id: profileId },
              data: { processed, matched: kept.size },
            });
          }
        }
      };
      await Promise.all(Array.from({ length: WORKERS }, worker));

      if (wanted.size > 0 && failures === wanted.size) {
        throw new Error("Couldn't reach Deezer to match the songs. Try again in a minute.");
      }

      await this.prisma.$transaction([
        // On a refresh, drop songs that are no longer in the user's lists.
        this.prisma.profileTrack.deleteMany({ where: { profileId, trackId: { notIn: [...kept] } } }),
        this.prisma.profile.update({
          where: { id: profileId },
          data: { status: "DONE", processed, matched: kept.size, importedAt: new Date() },
        }),
      ]);
    } catch (err) {
      const message = err instanceof LastfmError ? `Last.fm: ${err.message}` : (err as Error).message;
      this.logger.warn(`Import of ${username} failed: ${message}`);
      await this.prisma.profile
        .update({ where: { id: profileId }, data: { status: "FAILED", error: message.slice(0, 300) } })
        .catch(() => undefined);
    }
  }

  /** Find or create the Track for a song from another service. null if Deezer doesn't have it. */
  private async resolve(key: string, wanted: LastfmTrack): Promise<Track | null> {
    const known = await this.prisma.track.findFirst({ where: { songKey: key }, orderBy: { rank: "desc" } });
    if (known) return known;

    const hit = pickMatch(wanted.title, wanted.artist, await this.deezer.client.search(wanted.title, wanted.artist));
    if (!hit) return null;

    const deezerId = BigInt(hit.id);
    const byId = await this.prisma.track.findUnique({ where: { deezerId } });
    if (byId) return byId;

    // Search results carry no ISRC; the track endpoint does. It is what lets two
    // Deezer ids for the same recording collapse into one Track.
    const full = await this.deezer.client.track(hit.id).catch(() => hit);
    if (full.isrc) {
      const byIsrc = await this.prisma.track.findUnique({ where: { isrc: full.isrc } });
      if (byIsrc) return byIsrc;
    }

    const title = full.title_short ?? full.title;
    try {
      return await this.prisma.track.create({
        data: {
          deezerId,
          isrc: full.isrc ?? null,
          title,
          artist: full.artist.name,
          album: full.album?.title ?? null,
          coverUrl: full.album?.cover_medium ?? null,
          rank: full.rank ?? hit.rank ?? 0,
          songKey: songKey(title, full.artist.name),
          // Imported songs are played through their profile, not the default pool.
          inPool: false,
        },
      });
    } catch (err) {
      // Another worker (or another import) created it first.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return this.prisma.track.findFirst({
          where: { OR: [{ deezerId }, ...(full.isrc ? [{ isrc: full.isrc }] : [])] },
        });
      }
      throw err;
    }
  }
}

function toState(profile: Profile): ProfileState {
  return {
    id: profile.id,
    source: "lastfm",
    displayName: profile.displayName,
    status: profile.status.toLowerCase() as ProfileState["status"],
    total: profile.total,
    processed: profile.processed,
    matched: profile.matched,
    error: profile.error,
    importedAt: profile.importedAt?.toISOString() ?? null,
  };
}
