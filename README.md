# Split Second

Name the song in a split second. Each round starts with a 0.1s clip; drag the
log-scaled scrubber to unlock more, at a cost. A run is five songs, ordered easy to hard.

Open it and play: no account or name. Songs are the Billboard year-end hits of each year
from 2000 to now, or a Last.fm listener's own top and loved tracks. Audio comes from
Apple's public iTunes previews. Your best score is kept in the browser.

## Run it

Needs Node 22+, pnpm 10 and Docker (or any Postgres 14+).

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
pnpm db:up            # Postgres in Docker; skip if you have your own and edit DATABASE_URL
pnpm db:migrate       # create the tables
pnpm db:seed          # fill the pool with hits (slow: see below)
pnpm dev              # web on http://localhost:3000, API on http://localhost:4000
```

To play from Last.fm profiles, create a free API key at
<https://www.last.fm/api/account/create> and set `LASTFM_API_KEY` in `apps/api/.env`.
Then add a username in the lobby.

**The seed is slow, and that's fine.** Apple allows about 20 lookups a minute, so a full
seed (50 songs for each of 26 years) takes around an hour. It works down the charts across
all years at once, so after a few minutes the pool is already playable. Leave it running in
its own terminal, or stop it and run it again later: it continues where it stopped.

If the seed finds nothing or songs won't play, `pnpm check:services` tests each outside
service from your machine and says which one is the problem.

Seed and provider settings (environment or `apps/api/.env`):

| Setting | Default | |
| --- | --- | --- |
| `MUSIC_PROVIDER` | `itunes` | `itunes` works everywhere. `deezer` is not available in every country (India is one) |
| `HITS_FROM`, `HITS_TO` | 2000, this year | Range of years to collect hits for |
| `HITS_PER_YEAR` | 50 | How far down each year's chart to go; 0 skips the yearly hits |
| `ITUNES_COUNTRY` | `US` | iTunes storefront to search |
| `ITUNES_PER_MINUTE` | 19 | iTunes calls per minute |
| `SEED_PLAYLISTS` | empty | Deezer only: extra playlist ids to add as they are |

`pnpm test` runs the unit tests and, when `DATABASE_URL` is set, plays whole runs against
Postgres and mock iTunes, Wikipedia, Deezer and Last.fm servers. `apps/api/test/mock-services.ts`
runs those mocks standalone, for working offline (see the comment at the top of that file).

## Layout

| Path | What |
| --- | --- |
| `packages/shared` | Scoring formula, log-scale maths, title normalising, API types. Used by both apps. |
| `apps/api` | NestJS + Prisma. Runs, rounds, guesses, the iTunes, Deezer, Wikipedia and Last.fm clients, the seeders, profile import, audio proxy. |
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
fetches the preview server-side (cached in memory for 10 minutes), cuts it on frame
boundaries, and returns only the unlocked part. Apple's previews are AAC in an MP4
container, which can't simply be truncated, so the AAC frames are pulled out and re-wrapped
as an ADTS stream; Deezer's MP3s are cut between frames. Titles, artists, covers and
provider ids are sent only after the round ends. Later rounds are locked until the current
one is done.

**The song pool.** The database holds only song details (title, artist, provider id, rank,
year): about 1,300 small rows for 26 years at 50 a year. No audio is stored; each round
fetches a 30s preview. The hits are the Billboard Year-End Hot 100 of each year, read from
Wikipedia, and each song is matched to iTunes by title and artist, preferring the release
from around that year over later re-recordings. Chart position becomes the song's rank, so
a year's number 1 is "easy" and its number 50 is "hard". The year in progress has no
year-end chart until December, so the seed also adds Apple's current most-played songs.

**Providers.** `MUSIC_PROVIDER=itunes` (the default) uses Apple's iTunes Search API: no
key, works worldwide. `MUSIC_PROVIDER=deezer` uses Deezer instead, which adds ISRCs and a
real popularity rank but returns nothing playable in countries Deezer doesn't serve; its
seed finds each year's hits through Deezer playlists named after the year. A track row can
carry an id for either service.

**High score.** There are no accounts. The best score and the number of runs played are
kept in `localStorage`, separately for the hits pool and for each Last.fm profile.

**Guessing.** Autocomplete searches the pool by normalised title and artist. A guess is
correct if it is the same song after normalising ("feat.", "Remastered" and so on are
ignored), so picking another release of the right song counts.

**Difficulty.** The pool is sorted by `rank` (chart position, or Deezer's popularity) and
split into five bands; a run takes one random song from each, best known first. In a
profile run, songs with no rank are ordered by how often that listener played them.

**Last.fm profiles.** Adding a username fetches that user's top tracks (200 by default,
`LASTFM_TOP_LIMIT`) and loved tracks, merges duplicates, and matches each song to the
music provider: a search, then the first result whose normalised title and artist match
and that has a preview. On Deezer the track's ISRC is also looked up, so two ids for the
same recording become one `Track`. A track is shared by every profile that has it. The
import runs in the background and the lobby shows its progress; on iTunes it is paced at
about 20 songs a minute, so 200 songs take around ten minutes. A run started from a profile draws its
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

Before going public, check the API terms of Apple (iTunes Search), Last.fm and, if used, Deezer.
