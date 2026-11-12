# Split Second

Name the song in a split second. Each round starts with a 0.1s clip; drag the
log-scaled scrubber to unlock more, at a cost. A run is five songs, ordered easy to hard.

This is step 1 of the build: single-player with a fixed track pool from the Deezer public API.

## Run it

Needs Node 22+, pnpm 10 and Docker (or any Postgres 14+).

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
pnpm db:up            # Postgres in Docker; skip if you have your own and edit DATABASE_URL
pnpm db:migrate       # create the tables
pnpm db:seed          # fill the pool from the Deezer chart
pnpm dev              # web on http://localhost:3000, API on http://localhost:4000
```

To seed from specific Deezer playlists as well as the chart:

```bash
SEED_PLAYLISTS=1234567,7654321 pnpm db:seed
```

`pnpm test` runs the unit tests and, when `DATABASE_URL` is set, plays whole runs against
Postgres and a mock Deezer. `apps/api/test/mock-deezer.ts` is that mock as a standalone
server, for working offline (`DEEZER_API_BASE=http://127.0.0.1:4010`).

## Layout

| Path | What |
| --- | --- |
| `packages/shared` | Scoring formula, log-scale maths, title normalising, API types. Used by both apps. |
| `apps/api` | NestJS + Prisma. Runs, rounds, guesses, leaderboard, Deezer client, audio proxy. |
| `apps/web` | Next.js. Web Audio snippet player, scrubber, Fuse.js autocomplete. |

## How it works

**Scoring.** `round(10000 × (0.1 / t)^0.19) − 500 × wrongGuesses`, floored at 0. That is
10,000 at 0.1s and 3,383 at 30s. The server computes it; the client only shows a preview.

**Scrubber.** Position `p` in 0..1 maps to `0.1 × 300^p` seconds, so 0.1s→1s is as wide as
3s→30s. Dragging only selects a length. Pressing play commits it, and it can't go back down.

**Snippet player.** The clip is decoded to an `AudioBuffer` and played with
`source.start(when, offset, duration)` through a `GainNode` with 8ms fades. MP3 decoder
lead-in silence is detected and skipped so 0.1s is 0.1s of music.

**Anti-cheat.** The browser only knows an opaque round id. `GET /api/rounds/:id/audio`
fetches a fresh Deezer preview server-side (cached in memory for 10 minutes), cuts the MP3
on frame boundaries, and returns only the unlocked part. Titles, artists, covers and Deezer
ids are sent only after the round ends. Later rounds are locked until the current one is done.

**Guessing.** Autocomplete searches the pool by normalised title and artist. A guess is
correct if it is the same song after normalising ("feat.", "Remastered" and so on are
ignored), so picking another release of the right song counts.

**Difficulty.** The pool is sorted by Deezer `rank` and split into five bands; a run takes
one song from each, most popular first.

## API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/pool` | Guessable songs for autocomplete |
| POST | `/api/runs` | Start a run (`{ nickname? }`) |
| GET | `/api/runs/:id` | Run state, used to resume |
| POST | `/api/rounds/:id/unlock` | `{ seconds }`, only ever increases |
| GET | `/api/rounds/:id/audio` | MP3 of the unlocked part |
| POST | `/api/rounds/:id/guess` | `{ trackId }` |
| POST | `/api/rounds/:id/give-up` | End the round for 0 points |
| GET | `/api/leaderboard` | Best finished runs |

## Next steps

`Track` rows carry ISRC and a normalised song key, and `TrackSource` records where each
track came from (`seed` today). Last.fm import and multiple profiles add sources and a
per-run pool filter without changing the game tables. Multiplayer will need the timing
moved server-side, which is why unlocks and scores already live on the server.

Before going public, check Deezer's API terms for preview use.
