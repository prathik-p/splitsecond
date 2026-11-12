/**
 * Stand-ins for api.deezer.com and Last.fm, for developing or testing offline.
 *
 *   pnpm --filter @splitsecond/api exec tsx test/mock-services.ts [preview.mp3]
 *
 * then in apps/api/.env:
 *   DEEZER_API_BASE=http://127.0.0.1:4010
 *   LASTFM_API_BASE=http://127.0.0.1:4011/2.0/
 *   LASTFM_API_KEY=anything
 *
 * Last.fm users: "mira_v" (a full library), "tiny" (two songs), "nobody" (empty).
 * MOCK_DELAY_MS slows Deezer searches so import progress is visible.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import {
  fakeMp3,
  mockDeezerHandler,
  mockLastfmHandler,
  MockLastfmUser,
  MockPlaylist,
  MockTrack,
} from "./fixtures";

const DEEZER_PORT = 4010;
const LASTFM_PORT = 4011;
const mp3 = process.argv[2] ? readFileSync(process.argv[2]) : fakeMp3(1200);
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
// Spread the chart songs over a few years, each year with two "hits" playlists,
// so the by-year seed has something to find.
const hitYears = [2001, 2004, 2008, 2012, 2016, 2019, 2022, 2025];
const yearOf = (i: number) => hitYears[i % hitYears.length];

const tracks: MockTrack[] = [...chart, ...deepCuts].map(([title, artist], i) => ({
  id: 700_000 + i,
  title,
  artist,
  rank: 950_000 - i * 35_000,
  isrc: `MOCK${String(i).padStart(8, "0")}`,
  chart: i < chart.length,
  releaseDate: i < chart.length ? `${yearOf(i)}-05-01` : undefined,
}));

const playlists: MockPlaylist[] = hitYears.flatMap((year, y) => {
  const trackIds = tracks.filter((t, i) => i < chart.length && yearOf(i) === year).map((t) => t.id);
  return [
    { id: 100 + y * 2, title: `Hits ${year}`, trackIds, nbTracks: 40 },
    { id: 101 + y * 2, title: `Top ${year}`, trackIds, nbTracks: 40 },
  ];
});

const users: MockLastfmUser[] = [
  {
    name: "Mira_V",
    top: [
      ...deepCuts.map(([title, artist], i) => ({ title, artist, playcount: 240 - i * 11 })),
      { title: "Northbound - Remastered", artist: "Mira Vance", playcount: 90 },
      { title: "Glass Harbor", artist: "Low Tide Radio", playcount: 71 },
      { title: "Slow Comet (Live)", artist: "Ada Linde", playcount: 40 },
      { title: "A Bootleg Nobody Has", artist: "Basement Tapes", playcount: 12 },
      { title: "Untitled Demo 3", artist: "Mira Vance", playcount: 4 },
    ],
    loved: [
      { title: "Ferry Song", artist: "Low Tide Radio" },
      { title: "Copper Wire", artist: "The Longshore" },
    ],
  },
  {
    name: "tiny",
    top: [
      { title: "Lowlands", artist: "Pilot Season", playcount: 5 },
      { title: "Pilot Light", artist: "Pilot Season", playcount: 2 },
    ],
  },
  { name: "nobody", top: [] },
];

const deezer = mockDeezerHandler(tracks, mp3, () => `http://127.0.0.1:${DEEZER_PORT}`, undefined, playlists);
createServer((req, res) => {
  if (delay && req.url?.startsWith("/search")) setTimeout(() => deezer(req, res), delay);
  else deezer(req, res);
}).listen(DEEZER_PORT, "127.0.0.1", () =>
  console.log(`Mock Deezer on http://127.0.0.1:${DEEZER_PORT} with ${tracks.length} made-up songs`),
);
createServer(mockLastfmHandler(users)).listen(LASTFM_PORT, "127.0.0.1", () =>
  console.log(`Mock Last.fm on http://127.0.0.1:${LASTFM_PORT}/2.0/ with users ${users.map((u) => u.name).join(", ")}`),
);
