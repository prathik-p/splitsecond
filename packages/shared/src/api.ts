/** Shapes shared by the API and the web app. */

export interface PoolTrack {
  id: string;
  title: string;
  artist: string;
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
}

export interface RunState {
  runId: string;
  nickname: string | null;
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
