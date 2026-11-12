import type { GuessResult, LeaderboardEntry, PoolTrack, RoundState, RunState } from "@earshot/shared";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.message) message = Array.isArray(body.message) ? body.message.join(", ") : body.message;
    } catch {
      // not JSON, keep the generic message
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export const api = {
  pool: () => request<PoolTrack[]>("/pool"),
  createRun: (nickname?: string) => post<RunState>("/runs", { nickname }),
  getRun: (runId: string) => request<RunState>(`/runs/${runId}`),
  unlock: (roundId: string, seconds: number) => post<RoundState>(`/rounds/${roundId}/unlock`, { seconds }),
  guess: (roundId: string, trackId: string) => post<GuessResult>(`/rounds/${roundId}/guess`, { trackId }),
  giveUp: (roundId: string) => post<GuessResult>(`/rounds/${roundId}/give-up`),
  leaderboard: () => request<LeaderboardEntry[]>("/leaderboard?limit=10"),
  async audio(roundId: string): Promise<ArrayBuffer> {
    const res = await fetch(`/api/rounds/${roundId}/audio`, { cache: "no-store" });
    if (!res.ok) throw new Error("Couldn't load the audio for this song");
    return res.arrayBuffer();
  },
};
