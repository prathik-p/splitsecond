/**
 * Check every outside service the app relies on, from this machine.
 *
 *   pnpm check:services
 *
 * Useful when the seed finds nothing or songs won't play: it shows which
 * service is unreachable or answering oddly from where you are.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { sliceM4a } from "../src/audio/m4a";
import { currentChartIds } from "../src/charts/apple-chart";
import { chooseForEntry } from "../src/charts/billboard-seeder";
import { WikipediaCharts } from "../src/charts/wikipedia-charts";
import { ItunesClient } from "../src/itunes/itunes-client";

let failures = 0;

async function check(name: string, needed: boolean, run: () => Promise<string>) {
  try {
    console.log(`OK    ${name}: ${await run()}`);
  } catch (err) {
    if (needed) failures++;
    console.log(`${needed ? "FAIL " : "SKIP "} ${name}: ${(err as Error).message}`);
  }
}

async function main() {
  await check("Database", true, async () => {
    const prisma = new PrismaClient();
    try {
      const [pool, withYear] = await Promise.all([
        prisma.track.count({ where: { inPool: true } }),
        prisma.track.count({ where: { inPool: true, year: { not: null } } }),
      ]);
      return `connected, ${pool} songs in the pool (${withYear} with a year)`;
    } finally {
      await prisma.$disconnect();
    }
  });

  const itunes = new ItunesClient({
    baseUrl: process.env.ITUNES_API_BASE || undefined,
    country: process.env.ITUNES_COUNTRY || undefined,
  });
  let previewUrl: string | null = null;
  await check("iTunes search", true, async () => {
    const results = await itunes.search("Hey Ya!", "OutKast");
    const hit = chooseForEntry({ position: 1, title: "Hey Ya!", artist: "OutKast" }, 2004, results);
    if (!hit) {
      const seen = results.slice(0, 3).map((r) => `"${r.title}" by ${r.artist}${r.playable ? "" : " (no preview)"}`);
      throw new Error(`${results.length} results but no playable match. First few: ${seen.join("; ") || "none"}`);
    }
    previewUrl = hit.previewUrl;
    return `${results.length} results, matched "${hit.title}" by ${hit.artist} (released ${hit.releaseDate?.slice(0, 10)})`;
  });

  await check("iTunes preview audio", true, async () => {
    if (!previewUrl) throw new Error("no preview URL to test (search failed)");
    const res = await fetch(previewUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(previewUrl).host}`);
    const file = Buffer.from(await res.arrayBuffer());
    const whole = sliceM4a(file, Infinity);
    const short = sliceM4a(file, 0.1);
    return `${file.length} bytes, ${res.headers.get("content-type")}, ${whole.seconds.toFixed(1)}s of AAC; a 0.1s cut is ${short.aac.length} bytes`;
  });

  await check("Apple current chart", false, async () => {
    const feeds = (process.env.APPLE_CHART_URL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const { ids, feedUrl } = await currentChartIds(feeds.length ? feeds : undefined);
    return `${ids.length} songs from ${new URL(feedUrl).host}`;
  });

  await check("Wikipedia year-end chart (2005)", true, async () => {
    const list = await new WikipediaCharts(process.env.WIKIPEDIA_API_BASE || undefined, {
      userAgent: process.env.WIKIPEDIA_USER_AGENT || undefined,
    }).yearEnd(2005);
    if (list.length < 50) throw new Error(`parsed only ${list.length} entries; the page layout may have changed`);
    const [first] = list;
    return `${list.length} entries, number ${first.position} is "${first.title}" by ${first.artist}`;
  });

  console.log(failures ? `\n${failures} required check${failures === 1 ? "" : "s"} failed.` : "\nEverything needed is reachable.");
  process.exitCode = failures ? 1 : 0;
}

main();
