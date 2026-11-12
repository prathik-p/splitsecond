/**
 * Stand-in for api.deezer.com, for developing or testing without network access.
 *
 *   pnpm --filter @earshot/api exec tsx test/mock-deezer.ts [port] [preview.mp3]
 *   DEEZER_API_BASE=http://127.0.0.1:4010 pnpm db:seed
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fakeMp3, mockDeezerHandler, MockTrack } from "./fixtures";

const port = Number(process.argv[2] ?? 4010);
const mp3 = process.argv[3] ? readFileSync(process.argv[3]) : fakeMp3(1200);

const names: [string, string][] = [
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
const tracks: MockTrack[] = names.map(([title, artist], i) => ({
  id: 700_000 + i,
  title,
  artist,
  rank: 950_000 - i * 60_000,
  isrc: `MOCK${String(i).padStart(8, "0")}`,
}));

createServer(mockDeezerHandler(tracks, mp3, () => `http://127.0.0.1:${port}`)).listen(port, "127.0.0.1", () =>
  console.log(`Mock Deezer on http://127.0.0.1:${port} with ${tracks.length} made-up songs`),
);
