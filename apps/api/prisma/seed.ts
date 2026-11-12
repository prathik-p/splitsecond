/**
 * Fill the song pool from Deezer. Safe to re-run; it only adds and updates.
 *
 *   pnpm db:seed
 *
 * By default this adds the current chart plus the hits of every year from
 * 2000 to now (60 per year), found through Deezer playlists named after each
 * year. Only song details are stored; audio is fetched from Deezer per round.
 *
 * Settings (environment, or apps/api/.env):
 *   HITS_FROM=2000  HITS_TO=2026  HITS_PER_YEAR=60   (HITS_PER_YEAR=0 skips the yearly hits)
 *   SEED_PLAYLISTS=1234567,7654321                   extra Deezer playlists to add as they are
 *
 * To hand-pick the playlists for a year, list their ids in
 * prisma/hit-playlists.json, e.g. { "2005": ["1234567", "7654321"] }.
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { songKey } from "@splitsecond/shared";
import { DeezerClient, DeezerTrack } from "../src/deezer/deezer-client";
import { seedHits } from "../src/catalog/hits-seeder";

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

  console.log(`Saved ${saved} chart and playlist songs.`);

  const perYear = Number(process.env.HITS_PER_YEAR ?? 60);
  if (perYear > 0) {
    const fromYear = Number(process.env.HITS_FROM) || 2000;
    const toYear = Number(process.env.HITS_TO) || new Date().getFullYear();
    const pinnedFile = join(__dirname, "hit-playlists.json");
    const pinned = existsSync(pinnedFile) ? JSON.parse(readFileSync(pinnedFile, "utf8")) : {};
    console.log(`Finding the hits of ${fromYear} to ${toYear}, ${perYear} per year. This takes a few minutes…`);
    const hits = await seedHits(prisma, deezer, { fromYear, toYear, perYear, pinned, log: (m) => console.log(`  ${m}`) });
    console.log(`Saved ${hits.saved} hits.`);
  }

  const total = await prisma.track.count({ where: { inPool: true } });
  console.log(`The pool now has ${total} songs.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
