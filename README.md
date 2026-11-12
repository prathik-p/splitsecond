# Split Second

Name the song in a split second. Each round starts with a 0.1s clip; drag the
log-scaled scrubber to unlock more, at a cost. A run is five songs, ordered easy to hard.

Open it and play: no account or name. Songs are the hits of each year from 2000 to now,
or a Last.fm listener's own top and loved tracks. Your best score is kept in the browser.

## Run it

Needs Node 22+, pnpm 10 and Docker (or any Postgres 14+).

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
pnpm db:up            # Postgres in Docker; skip if you have your own and edit DATABASE_URL
pnpm db:migrate       # create the tables
pnpm db:seed          # fill the pool with hits from Deezer (takes a few minutes)
pnpm dev              # web on http://localhost:3000, API on http://localhost:4000
```

To play from Last.fm profiles, create a free API key at
<https://www.last.fm/api/account/create> and set `LASTFM_API_KEY` in `apps/api/.env`.
Then add a username in the lobby.

The seed is safe to re-run. Its settings (environment or `apps/api/.env`):

| Setting | Default | |
| --- | --- | --- |
| `HITS_FROM`, `HITS_TO` | 2000, this year | Range of years to collect hits for |
| `HITS_PER_YEAR` | 60 | Songs per year; 0 skips the yearly hits |
| `SEED_PLAYLISTS` | empty | Extra Deezer playlist ids to add as they are |

`pnpm test` runs the unit tests and, when `DATABASE_URL` is set, plays whole runs against
Postgres and mock Deezer and Last.fm servers. `apps/api/test/mock-services.ts` runs those
mocks standalone, for working offline (see the comment at the top of that file).

## Layout

| Path | What |
| --- | --- |
| `packages/shared` | Scoring formula, log-scale maths, title normalising, API types. Used by both apps. |
| `apps/api` | NestJS + Prisma. Runs, rounds, guesses, leaderboard, Deezer and Last.fm clients, profile import, audio proxy. |
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

**The song pool.** The database holds only song details (title, artist, Deezer id, rank,
year): about 1,600 small rows for 27 years at 60 a year. No audio is stored; each round
fetches a fresh 30s preview from Deezer. Deezer has no chart-by-year endpoint, so the seed
finds each year's hits through public playlists named after that year ("Hits 2005",
"Top 2005"), ranks songs by how many of those playlists include them and then by Deezer
popularity, and drops songs whose release date doesn't fit the year. If a year comes out
thin or off, pin the playlists to use in `apps/api/prisma/hit-playlists.json`, for example
`{ "2005": ["1234567", "7654321"] }`, and re-run the seed.

**High score.** There are no accounts. The best score and the number of runs played are
kept in `localStorage`, separately for the hits pool and for each Last.fm profile.

**Guessing.** Autocomplete searches the pool by normalised title and artist. A guess is
correct if it is the same song after normalising ("feat.", "Remastered" and so on are
ignored), so picking another release of the right song counts.

**Difficulty.** The pool is sorted by Deezer `rank` and split into five bands; a run takes
one song from each, most popular first.

**Last.fm profiles.** Adding a username fetches that user's top tracks (200 by default,
`LASTFM_TOP_LIMIT`) and loved tracks, merges duplicates, and matches each song to Deezer:
a field search (`artist:"…" track:"…"`), then the most popular result whose normalised
title and artist match and that has a preview. The track's ISRC is then looked up so two
Deezer ids for the same recording become one `Track`, shared by every profile that has it.
The import runs in the background (about two Deezer requests per new song, rate-limited to
45 per 5 seconds) and the lobby shows its progress. A run started from a profile draws its
five songs and its autocomplete list from that profile only.

## API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/pool` | Songs in the default (hits) pool |
| GET | `/api/pool/summary` | Size and year range of the default pool |
| GET | `/api/profiles` | Imported profiles and their import status |
| POST | `/api/profiles` | Import a Last.fm user (`{ username, refresh? }`) |
| GET | `/api/profiles/:id` | One profile, polled for import progress |
| POST | `/api/runs` | Start a run (`{ profileId? }`) |
| GET | `/api/runs/:id` | Run state, used to resume |
| GET | `/api/runs/:id/pool` | Guessable songs for that run's autocomplete |
| POST | `/api/rounds/:id/unlock` | `{ seconds }`, only ever increases |
| GET | `/api/rounds/:id/audio` | MP3 of the unlocked part |
| POST | `/api/rounds/:id/guess` | `{ trackId }` |
| POST | `/api/rounds/:id/give-up` | End the round for 0 points |
| GET | `/api/leaderboard` | Best finished runs on the server. Not shown in the app yet; kept for multiplayer |

## Next steps

A run is linked to its profiles through a many-to-many relation and the pool query already
takes a list of profile ids, so several profiles in one game (step 3) needs a picker, a
per-profile weighting when choosing songs, and the "whose song is this?" round, without
schema changes to the game tables. Multiplayer (step 4) will need the timing moved
server-side, which is why unlocks and scores already live on the server.

Before going public, check Deezer's and Last.fm's API terms.
