import { MAX_SECONDS, MIN_SECONDS, clampSeconds } from "./scoring";

/**
 * The scrubber is log-scaled: position p in [0, 1] maps to MIN * (MAX/MIN)^p.
 * With 0.1s..30s, the stretch 0.1s→1s takes the same width as 3s→30s.
 */
const RATIO = MAX_SECONDS / MIN_SECONDS;

export function positionToSeconds(position: number): number {
  const p = Math.min(1, Math.max(0, position));
  return MIN_SECONDS * Math.pow(RATIO, p);
}

export function secondsToPosition(seconds: number): number {
  return Math.log(clampSeconds(seconds) / MIN_SECONDS) / Math.log(RATIO);
}

/**
 * Round a raw scrubber value to a tidy length so players see "0.3s" or "12s"
 * rather than "0.2871s". The step grows with the length, matching the log scale.
 */
export function snapSeconds(seconds: number): number {
  const t = clampSeconds(seconds);
  const step = t < 1 ? 0.1 : t < 3 ? 0.25 : t < 10 ? 0.5 : 1;
  const snapped = Math.round(t / step) * step;
  return clampSeconds(Number(snapped.toFixed(2)));
}

/** The marked lengths on the scrubber, and the steps the skip button takes. */
export const LENGTH_STOPS = [0.1, 0.5, 1, 2, 4, 8, 15, 30] as const;

/** The next marked length after `seconds`, or null at the full clip. */
export function nextStop(seconds: number): number | null {
  return LENGTH_STOPS.find((s) => s > seconds + 1e-9) ?? null;
}

export function formatSeconds(seconds: number): string {
  if (seconds < 1) return `${seconds.toFixed(1)}s`;
  if (seconds < 10 && !Number.isInteger(seconds)) return `${Number(seconds.toFixed(2))}s`;
  return `${Math.round(seconds)}s`;
}
