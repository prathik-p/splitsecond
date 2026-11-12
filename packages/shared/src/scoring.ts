/** Shortest snippet a round starts with, in seconds. */
export const MIN_SECONDS = 0.1;
/** Longest snippet a player can unlock (Deezer previews are 30s). */
export const MAX_SECONDS = 30;
/** Points for a correct guess at MIN_SECONDS with no wrong guesses. */
export const MAX_POINTS = 10_000;
/** How steeply points fall off as more audio is unlocked. */
export const DECAY_EXPONENT = 0.19;
/** Points lost per wrong guess. A wrong guess never ends the round. */
export const WRONG_GUESS_PENALTY = 500;
/** Songs per run. */
export const RUN_LENGTH = 5;

/** Clamp a snippet length to the playable range. */
export function clampSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return MIN_SECONDS;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, seconds));
}

/** Points available for a correct guess after hearing `seconds`, before penalties. */
export function basePoints(seconds: number): number {
  const t = clampSeconds(seconds);
  return Math.round(MAX_POINTS * Math.pow(MIN_SECONDS / t, DECAY_EXPONENT));
}

/** Final points for a solved round. Never negative. */
export function scoreRound(seconds: number, wrongGuesses: number): number {
  return Math.max(0, basePoints(seconds) - WRONG_GUESS_PENALTY * Math.max(0, wrongGuesses));
}
