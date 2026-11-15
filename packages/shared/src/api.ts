/** Shapes shared by the API and the web app. */

export interface PoolTrack {
  id: string;
  title: string;
  artist: string;
}

/** What the default pool holds, for the lobby. */
export interface PoolSummary {
  songs: number;
  /** Range of hit years in the pool, or null if no song has a year. */
  yearFrom: number | null;
  yearTo: number | null;
}

/**
 * What a run can be limited to, for the lobby's run options. Kept compact:
 * songs point into the two name lists.
 */
export interface PoolOptions {
  /** Genre names, biggest first. */
  genres: string[];
  artists: string[];
  /** One entry per song: g is its genre's index (-1 if unknown), a its artists' indexes. */
  songs: { g: number; a: number[] }[];
}

/** The genres and artists a run is limited to. An empty list means any. */
export interface RunFilters {
  genres: string[];
  artists: string[];
}

export interface RoundState {
  roundId: string;
  index: number;
  unlockedSeconds: number;
  wrongGuesses: number;
  status: "playing" | "solved" | "given_up";
  score: number | null;
  /** Revealed only once the round is over. */
  answer: RevealedTrack | null;
}

export interface RevealedTrack {
  title: string;
  artist: string;
  album: string | null;
  coverUrl: string | null;
  year: number | null;
}

export interface ProfileState {
  id: string;
  source: "lastfm";
  displayName: string;
  status: "pending" | "running" | "done" | "failed";
  /** Songs found on the source, looked at so far, and matched to a playable track. */
  total: number;
  processed: number;
  matched: number;
  error: string | null;
  importedAt: string | null;
}

/** Where a run's songs come from. null means the default pool. */
export interface RunSource {
  profileId: string;
  displayName: string;
}

export interface RunState {
  runId: string;
  nickname: string | null;
  source: RunSource | null;
  /** The run options it was started with. */
  filters: RunFilters;
  totalScore: number;
  finished: boolean;
  rounds: RoundState[];
}

export interface GuessResult {
  correct: boolean;
  round: RoundState;
  run: RunState;
}

export interface LeaderboardEntry {
  runId: string;
  nickname: string;
  totalScore: number;
  finishedAt: string;
}
