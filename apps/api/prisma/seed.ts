/**
 * Fill the song pool from Deezer: the global chart plus any playlists in
 * SEED_PLAYLISTS (comma-separated Deezer playlist ids). Safe to re-run.
 *
 *   pnpm db:seed
 *   SEED_PLAYLISTS=1234567,7654321 pnpm db:seed
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { songKey } from "@earshot/shared";
import { DeezerClient, DeezerTrack } from "../src/deezer/deezer-client";

const prisma = new PrismaClient();
const deezer = new DeezerClient(process.env.DEEZER_API_BASE || "https://api.deezer.com");

async function main() {
  const sources: { reference: string; tracks: DeezerTrack[] }[] = [];

  console.log("Fetching the Deezer chart…");
  sources.push({ reference: "chart", tracks: await deezer.chartTracks(100) });

  const playlists = (process.env.SEED_PLAYLISTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of playlists) {
    console.log(`Fetching playlist ${id}…`);
    sources.push({ reference: `playlist:${id}`, tracks: await deezer.playlistTracks(id) });
  }

  // Keep the most popular release of each song; dedupe by ISRC and by normalised title+artist.
  const byKey = new Map<string, { track: DeezerTrack; refs: Set<string> }>();
  const listed = sources.flatMap((s) => s.tracks.map((t) => ({ t, ref: s.reference })));
  console.log(`Looking up ${listed.length} tracks for ISRCs…`);

  for (const { t, ref } of listed) {
    if (!t.preview || t.readable === false) continue;
    const full = t.isrc ? t : await deezer.track(t.id).catch(() => null);
    if (!full?.preview) continue;
    const key = songKey(full.title_short ?? full.title, full.artist.name);
    const existing = byKey.get(key);
    if (existing) {
      existing.refs.add(ref);
      if (full.rank > existing.track.rank) existing.track = full;
    } else {
      byKey.set(key, { track: full, refs: new Set([ref]) });
    }
  }

  const seenIsrc = new Set<string>();
  let saved = 0;
  for (const [key, { track, refs }] of byKey) {
    if (track.isrc) {
      if (seenIsrc.has(track.isrc)) continue;
      seenIsrc.add(track.isrc);
    }
    const data = {
      isrc: track.isrc ?? null,
      title: track.title_short ?? track.title,
      artist: track.artist.name,
      album: track.album?.title ?? null,
      coverUrl: track.album?.cover_medium ?? null,
      rank: track.rank,
      songKey: key,
      inPool: true,
    };
    try {
      const row = await prisma.track.upsert({
        where: { deezerId: BigInt(track.id) },
        create: { deezerId: BigInt(track.id), ...data },
        update: data,
      });
      for (const reference of refs) {
        await prisma.trackSource.upsert({
          where: { trackId_kind_reference: { trackId: row.id, kind: "seed", reference } },
          create: { trackId: row.id, kind: "seed", reference },
          update: {},
        });
      }
      saved++;
    } catch (err) {
      // Most likely the ISRC already belongs to another Deezer id from an earlier seed.
      console.warn(`Skipped "${data.title}" by ${data.artist}: ${(err as Error).message.split("\n").pop()}`);
    }
  }

  const total = await prisma.track.count({ where: { inPool: true } });
  console.log(`Saved ${saved} songs. The pool now has ${total}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
