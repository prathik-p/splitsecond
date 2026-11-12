# Split Second

Name the song in a split second. Each round starts with a 0.1s clip; drag the
log-scaled scrubber to unlock more, at a cost. A run is five songs, ordered easy to hard.

Songs come from the Deezer charts or from a Last.fm listener's own top and loved tracks,
so you can be tested on music you actually listen to.

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

To play from Last.fm profiles, create a free API key at
<https://www.last.fm/api/account/create> and set `LASTFM_API_KEY` in `apps/api/.env`.
Then add a username in the lobby.

To seed from specific Deezer playlists as well as the chart:

```bash
SEED_PLAYLISTS=1234567,7654321 pnpm db:seed
```

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
five songs and its autocomplete list from that profile only, and has its own leaderboard.

## API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/pool` | Songs in the default (charts) pool |
| GET | `/api/profiles` | Imported profiles and their import status |
| POST | `/api/profiles` | Import a Last.fm user (`{ username, refresh? }`) |
| GET | `/api/profiles/:id` | One profile, polled for import progress |
| POST | `/api/runs` | Start a run (`{ nickname?, profileId? }`) |
| GET | `/api/runs/:id` | Run state, used to resume |
| GET | `/api/runs/:id/pool` | Guessable songs for that run's autocomplete |
| POST | `/api/rounds/:id/unlock` | `{ seconds }`, only ever increases |
| GET | `/api/rounds/:id/audio` | MP3 of the unlocked part |
| POST | `/api/rounds/:id/guess` | `{ trackId }` |
| POST | `/api/rounds/:id/give-up` | End the round for 0 points |
| GET | `/api/leaderboard` | Best finished runs (`?profileId=` for a profile's board) |

## Next steps

A run is linked to its profiles through a many-to-many relation and the pool query already
takes a list of profile ids, so several profiles in one game (step 3) needs a picker, a
per-profile weighting when choosing songs, and the "whose song is this?" round, without
schema changes to the game tables. Multiplayer (step 4) will need the timing moved
server-side, which is why unlocks and scores already live on the server.

Before going public, check Deezer's and Last.fm's API terms.
