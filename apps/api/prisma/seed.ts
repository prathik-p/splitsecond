/**
 * Fill the song pool. Safe to re-run; it only adds and updates, and picks up
 * where it stopped.
 *
 *   pnpm db:seed
 *
 * Only song details are stored. Audio is fetched per round, never saved.
 *
 * With MUSIC_PROVIDER=itunes (the default, works everywhere):
 *   - the Billboard Year-End Hot 100 of each year, read from Wikipedia, with each
 *     song matched to Apple's iTunes catalog for its preview
 *   - Apple's current chart, which covers the year in progress
 *   Apple allows about 20 lookups a minute, so a full seed takes around an hour.
 *   It works down the charts across all years at once: stop it whenever you
 *   like and the pool is already playable; run it again to continue.
 *
 * With MUSIC_PROVIDER=deezer (not available in every country, India included):
 *   - Deezer's chart plus each year's hits found through Deezer playlists
 *
 * Settings (environment, or apps/api/.env):
 *   HITS_FROM=2000  HITS_TO=<this year>  HITS_PER_YEAR=50   (0 skips the yearly hits)
 *   WIKIPEDIA_USER_AGENT="my-app/1.0 (me@example.com)"   optional; Wikipedia limits named clients less
 *   SEED_PLAYLISTS=1234567,7654321   Deezer only: extra playlists to add as they are
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { songKey } from "@splitsecond/shared";
import { activeProvider } from "../src/catalog/catalog.service";
import { seedHits } from "../src/catalog/hits-seeder";
import { seedAppleChart } from "../src/charts/apple-chart";
import { seedBillboard } from "../src/charts/billboard-seeder";
import { WikipediaCharts } from "../src/charts/wikipedia-charts";
import { DeezerClient, DeezerTrack } from "../src/deezer/deezer-client";
import { ItunesClient } from "../src/itunes/itunes-client";

const prisma = new PrismaClient();
const fromYear = Number(process.env.HITS_FROM) || 2000;
const toYear = Number(process.env.HITS_TO) || new Date().getFullYear();
const perYear = Number(process.env.HITS_PER_YEAR ?? 50);
const indent = (m: string) => console.log(`  ${m}`);

/** APPLE_CHART_URL can name one feed or several, comma-separated; unset uses Apple's two public feeds. */
const feedUrls = () => (process.env.APPLE_CHART_URL ?? "").split(",").map((s) => s.trim()).filter(Boolean);

async function seedFromItunes() {
  const itunes = new ItunesClient({
    baseUrl: process.env.ITUNES_API_BASE || undefined,
    country: process.env.ITUNES_COUNTRY || undefined,
    perMinute: Number(process.env.ITUNES_PER_MINUTE) || undefined,
  });

  console.log("Adding Apple's current chart…");
  try {
    const n = await seedAppleChart(prisma, itunes, { feedUrls: feedUrls(), fromYear });
    console.log(`  ${n} current hits in the pool.`);
  } catch (err) {
    console.log(`  Skipped: ${(err as Error).message}`);
  }

  if (perYear <= 0) return;
  console.log(`Adding the Billboard year-end top ${perYear} of ${fromYear} to ${toYear}.`);
  console.log("Apple allows about 20 lookups a minute, so this is slow. You can stop it and re-run to continue.");
  console.log("Reading the charts from Wikipedia, one every second or two…");
  const charts = new WikipediaCharts(process.env.WIKIPEDIA_API_BASE || undefined, {
    userAgent: process.env.WIKIPEDIA_USER_AGENT || undefined,
    onWait: (seconds) => indent(`Wikipedia asked us to slow down; trying again in ${seconds}s`),
  });
  const result = await seedBillboard(prisma, itunes, charts, { fromYear, toYear, perYear, log: indent });
  // A song on two years' charts is one song in the pool, so this can be more than the pool grew by.
  console.log(`${result.saved} chart entries matched to a song, ${result.missed} not found on iTunes.`);
  if (result.unread.length) {
    console.log(`Couldn't read the chart for: ${result.unread.join(", ")}. Run the seed again in a few minutes to add them.`);
  }
}

async function seedFromDeezer() {
  const base = process.env.DEEZER_API_BASE || "https://api.deezer.com";
  const deezer = new DeezerClient(base);

  // Deezer answers from unsupported countries, but with nothing playable.
  const infos = (await fetch(`${base}/infos`).then((r) => r.json()).catch(() => null)) as
    | { open?: boolean; country?: string }
    | null;
  if (infos && infos.open === false) {
    console.error(
      `Deezer isn't available in ${infos.country ?? "your country"}, so it returns no playable songs.\n` +
        "Remove MUSIC_PROVIDER=deezer from apps/api/.env to use Apple's previews instead, or run this through a VPN.",
    );
    process.exitCode = 1;
    return;
  }

  const sources: { reference: string; tracks: DeezerTrack[] }[] = [];
  console.log("Fetching the Deezer chart…");
  sources.push({ reference: "chart", tracks: await deezer.chartTracks(100) });
  const playlists = (process.env.SEED_PLAYLISTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of playlists) {
    console.log(`Fetching playlist ${id}…`);
    sources.push({ reference: `playlist:${id}`, tracks: await deezer.playlistTracks(id) });
  }

  // Keep the most popular release of each song; dedupe by ISRC and by normalised title+artist.
  const byKey = new Map<string, { track: DeezerTrack; refs: Set<string> }>();
  for (const { t, ref } of sources.flatMap((s) => s.tracks.map((t) => ({ t, ref: s.reference })))) {
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

  if (perYear > 0) {
    const pinnedFile = join(__dirname, "hit-playlists.json");
    const pinned = existsSync(pinnedFile) ? JSON.parse(readFileSync(pinnedFile, "utf8")) : {};
    console.log(`Finding the hits of ${fromYear} to ${toYear}, ${perYear} per year. This takes a few minutes…`);
    const hits = await seedHits(prisma, deezer, { fromYear, toYear, perYear, pinned, log: indent });
    console.log(`Saved ${hits.saved} hits.`);
  }
}

async function main() {
  const provider = activeProvider();
  console.log(`Music provider: ${provider === "itunes" ? "Apple iTunes" : "Deezer"}`);
  await (provider === "itunes" ? seedFromItunes() : seedFromDeezer());
  const total = await prisma.track.count({ where: { inPool: true } });
  console.log(`The pool now has ${total} songs.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
