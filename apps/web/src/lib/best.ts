/**
 * Personal bests, kept in this browser only. One per song source, since a run
 * on your own Last.fm library isn't comparable to one on the hits pool.
 */
const KEY = "splitsecond.best";
/** Source key for the default pool. Profiles use their id. */
export const HITS = "hits";

export interface Best {
  score: number;
  /** ISO date the best was set. */
  at: string;
  /** Runs finished on this source. */
  runs: number;
}

type Store = Record<string, Best>;

function read(): Store {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

export function getBest(source: string): Best | null {
  const best = read()[source];
  return best && typeof best.score === "number" ? best : null;
}

/**
 * Record a finished run. Returns the best after recording and whether this run
 * set it. Each run is counted once, however often it is reported.
 */
export function recordRun(source: string, runId: string, score: number): { best: Best; isNew: boolean } {
  const store = read();
  const previous = store[source];
  const counted = `${KEY}.counted`;
  let already = false;
  try {
    already = window.localStorage.getItem(counted) === runId;
  } catch {
    // ignore
  }
  if (already && previous) return { best: previous, isNew: false };

  const isNew = !previous || score > previous.score;
  const best: Best = {
    score: isNew ? score : previous.score,
    at: isNew ? new Date().toISOString() : previous.at,
    runs: (previous?.runs ?? 0) + 1,
  };
  store[source] = best;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
    window.localStorage.setItem(counted, runId);
  } catch {
    // private mode: the score just won't be remembered
  }
  return { best, isNew };
}
