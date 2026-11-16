/**
 * Fill the song pool. Safe to re-run; it only adds and updates, and picks up
 * where it stopped.
 *
 *   pnpm db:seed
 *
 * Only song details are stored. Audio is fetched per round, never saved.
 *
 * Songs and 30-second previews come from Apple's iTunes Search API (no key needed):
 *   - the Billboard Year-End Hot 100 of each year, read from Wikipedia, with each
 *     song matched to Apple's catalog for its preview
 *   - Apple's current chart, which covers the year in progress
 *   - each song's genre, for the lobby's run options (filled in for older songs too)
 *   - every song by the artists listed in artists.txt (at the top of the project)
 *   - a fix for any song in the pool that is a live, livestream or remix version
 *   Apple allows about 20 lookups a minute, so a full seed takes around an hour.
 *   It works down the charts across all years at once: stop it whenever you
 *   like and the pool is already playable; run it again to continue.
 *
 * Settings (environment, or apps/api/.env):
 *   HITS_FROM=2000  HITS_TO=<this year>  HITS_PER_YEAR=50   (0 skips the yearly hits)
 *   WIKIPEDIA_USER_AGENT="my-app/1.0 (me@example.com)"   optional; Wikipedia limits named clients less
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { seedAppleChart } from "../src/charts/apple-chart";
import { parseArtistsFile, seedArtists } from "../src/charts/artist-seeder";
import { repairVersions } from "../src/charts/repair-versions";
import { seedBillboard } from "../src/charts/billboard-seeder";
import { fillGenres } from "../src/charts/genres";
import { WikipediaCharts } from "../src/charts/wikipedia-charts";
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
    // The seed can afford to be patient: up to about 14 minutes of waiting on one lookup.
    attempts: 8,
    onWait: ({ seconds, reason, rateLimited, perMinute }) =>
      indent(
        rateLimited
          ? `Apple asked us to slow down (${reason}); waiting ${seconds}s, then continuing at ${perMinute} lookups a minute`
          : `${reason}; trying again in ${seconds}s`,
      ),
  });

  const untagged = await prisma.track.count({ where: { itunesId: { not: null }, genre: null } });
  if (untagged > 0) {
    console.log(`Adding genres to ${untagged} songs already saved…`);
    try {
      const { filled, missing } = await fillGenres(prisma, itunes);
      console.log(`  ${filled} songs now have a genre${missing ? `; Apple lists none for ${missing}` : ""}.`);
    } catch (err) {
      console.log(`  Stopped: ${(err as Error).message}. The next seed continues.`);
    }
  }

  // Older seeds could match a hit to a live or livestream version; swap those for the original.
  const repair = await repairVersions(prisma, itunes, { log: indent });
  if (repair.swapped || repair.removed) {
    console.log(`  ${repair.swapped} switched to the original recording, ${repair.removed} taken out.`);
  }
  if (repair.stopped) console.log("  Apple is refusing lookups; the next seed finishes this.");

  console.log("Adding Apple's current chart…");
  try {
    const n = await seedAppleChart(prisma, itunes, { feedUrls: feedUrls(), fromYear });
    console.log(`  ${n} current hits in the pool.`);
  } catch (err) {
    console.log(`  Skipped: ${(err as Error).message}`);
  }

  await seedArtistCatalogues(itunes);

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
  if (result.remaining) {
    console.log(
      `Stopped early: Apple is still refusing lookups after several minutes of waiting. ${result.remaining} chart entries are left.\n` +
        "Everything so far is saved. Run the seed again in half an hour or so to continue; ITUNES_PER_MINUTE=12 in apps/api/.env makes it gentler.",
    );
  }
  if (result.unread.length) {
    console.log(`Couldn't read the chart for: ${result.unread.join(", ")}. Run the seed again in a few minutes to add them.`);
  }
}

/** artists.txt at the top of the project: artists whose every song should be in the pool. */
async function seedArtistCatalogues(itunes: ItunesClient) {
  const file = process.env.ARTISTS_FILE || join(__dirname, "../../../artists.txt");
  // Without the file nothing changes; an emptied file takes its artists out again.
  if (!existsSync(file)) return;
  const lines = parseArtistsFile(readFileSync(file, "utf8"));
  if (lines.length === 0 && (await prisma.artistImport.count()) === 0) return;
  console.log(
    lines.length
      ? `Adding the whole catalogue of ${lines.length} ${lines.length === 1 ? "artist" : "artists"} from artists.txt…`
      : "artists.txt lists no artists now…",
  );
  const result = await seedArtists(prisma, itunes, lines, { log: indent });
  console.log(`  ${result.added} songs added${result.removed ? `, ${result.removed} taken out` : ""}.`);
  if (result.stopped) {
    console.log("  Stopped early: Apple is still refusing lookups. Run the seed again in half an hour or so to continue.");
  }
}

async function main() {
  await seedFromItunes();
  const total = await prisma.track.count({ where: { inPool: true } });
  console.log(`The pool now has ${total} songs.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
