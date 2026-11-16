/**
 * Stand-ins for every outside service, for developing or testing offline.
 *
 *   pnpm --filter @splitsecond/api exec tsx test/mock-services.ts [preview.m4a]
 *
 * then in apps/api/.env:
 *   ITUNES_API_BASE=http://127.0.0.1:4012
 *   ITUNES_PER_MINUTE=6000
 *   WIKIPEDIA_API_BASE=http://127.0.0.1:4012/w/api.php
 *   APPLE_CHART_URL=http://127.0.0.1:4012/chart.json
 *
 * MOCK_DELAY_MS slows searches so seed progress is visible.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MockItunesSong, startMockApple } from "./fixtures";

const APPLE_PORT = 4012;
const m4a = readFileSync(process.argv[2] ?? join(__dirname, "data/tone-fast.m4a"));
const delay = Number(process.env.MOCK_DELAY_MS ?? 0);

const chart: [string, string][] = [
  ["Paper Lanterns", "The Quiet Hours"],
  ["Northbound", "Mira Vance"],
  ["Glass Harbor", "Low Tide Radio"],
  ["Kerosene Summer", "Dusty Atlas"],
  ["Small Hours", "Odette Ray"],
  ["Static Bloom", "Neon Orchard"],
  ["Halfway to Lisbon", "Marlowe & Finch"],
  ["Copper Wire", "The Longshore"],
  ["Violet Engine", "Sable Kids"],
  ["Everything Tilts", "June Okafor"],
  ["Salt and Signal", "Harbor Lights"],
  ["Midnight Arithmetic", "Tobias Wren"],
  ["Slow Comet", "Ada Linde"],
  ["Paper Planes Home", "The Quiet Hours"],
  ["Lowlands", "Pilot Season"],
];
const deepCuts: [string, string][] = [
  ["Atlas of Small Things", "Odette Ray"],
  ["Tin Roof Weather", "Dusty Atlas"],
  ["Second Floor Sun", "Neon Orchard"],
  ["Ferry Song", "Low Tide Radio"],
  ["Orchard Static", "Neon Orchard"],
  ["Longhand", "Ada Linde"],
  ["Blue Hour Taxi", "Sable Kids"],
  ["Quiet Machines", "The Quiet Hours"],
  ["Anchor Year", "Harbor Lights"],
  ["Winter Arithmetic", "Tobias Wren"],
  ["Lisbon, Later", "Marlowe & Finch"],
  ["Pilot Light", "Pilot Season"],
];
// Spread the chart songs over a few years, so the by-year seed has something to find.
const hitYears = [2001, 2004, 2008, 2012, 2016, 2019, 2022, 2025];
const yearOf = (i: number) => hitYears[i % hitYears.length];

const tracks = [...chart, ...deepCuts].map(([title, artist], i) => ({
  title,
  artist,
  releaseDate: i < chart.length ? `${yearOf(i)}-05-01` : undefined,
}));

// Made-up songs on a mock iTunes, with a year-end chart per hit year.
const genres = ["Pop", "Alternative", "Pop", "Hip-Hop/Rap"];
// Every act can be put in artists.txt: its songs sit on one album each.
const acts = [...new Set(tracks.map((t) => t.artist))].map((name, i) => ({ id: 600_000 + i, name }));
const itunesSongs: MockItunesSong[] = tracks.map((t, i) => {
  const act = acts.find((a) => a.name === t.artist)!;
  return {
    id: 800_000 + i,
    title: t.title,
    artist: t.artist,
    releaseDate: `${t.releaseDate ?? "2015-01-01"}T08:00:00Z`,
    genre: genres[i % genres.length],
    artistId: act.id,
    albumId: act.id + 50_000,
    albumName: `The ${t.artist.replace(/^The /, "")} Album`,
    durationMs: 210_000,
  };
});
const charts = Object.fromEntries(
  hitYears.map((year) => [
    year,
    tracks
      .filter((t, i) => i < chart.length && yearOf(i) === year)
      .map((t, position) => ({ position: position + 1, title: t.title, artist: t.artist })),
  ]),
);
// What `pnpm check:services` searches for.
itunesSongs.push({ id: 899_999, title: "Hey Ya!", artist: "OutKast", releaseDate: "2003-09-09T07:00:00Z" });
void startMockApple(itunesSongs, m4a, {
  charts,
  mostPlayed: [800_000 + 14, 800_000 + 6],
  topSongs: [800_000 + 14, 800_000 + 6],
  artists: acts,
  port: APPLE_PORT,
  delayMs: delay,
}).then(() => console.log(`Mock iTunes, Apple chart and Wikipedia on http://127.0.0.1:${APPLE_PORT}`));
