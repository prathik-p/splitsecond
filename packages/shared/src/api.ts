/** Shapes shared by the API and the web app. */

export interface PoolTrack {
  id: string;
  title: string;
  artist: string;
}

/**
 * What a run can be limited to, for the lobby's run options. Kept compact:
 * songs point into the two name lists.
 */
export interface PoolOptions {
  /** Genre names, biggest first. */
  genres: string[];
  artists: string[];
  /**
   * One entry per song: g is its genre's index (-1 if unknown), a its artists' indexes.
   * d marks a deep cut: a song that is here because its artist's whole catalogue was
   * added, and that comes up only when one of its artists is picked.
   */
  songs: { g: number; a: number[]; d?: 1 }[];
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

export interface RunState {
  runId: string;
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
