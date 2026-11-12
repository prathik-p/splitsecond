"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_SECONDS,
  RUN_LENGTH,
  WRONG_GUESS_PENALTY,
  basePoints,
  formatSeconds,
  scoreRound,
  type LeaderboardEntry,
  type PoolTrack,
  type RoundState,
  type RunState,
} from "@splitsecond/shared";
import { api } from "@/lib/api";
import { SnippetPlayer, type LoadedClip } from "@/lib/snippet-player";
import { Scrubber } from "./Scrubber";
import { GuessInput } from "./GuessInput";

const RUN_KEY = "splitsecond.run";
const NAME_KEY = "splitsecond.nickname";
const fmt = (n: number) => n.toLocaleString("en-US");

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // private mode: the game still works, it just won't resume
  }
}

export function Game() {
  const [pool, setPool] = useState<PoolTrack[] | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Index of the round on screen. Stays on a finished round until "Next". */
  const [viewIndex, setViewIndex] = useState(0);

  const refreshLeaderboard = useCallback(() => {
    api.leaderboard().then(setLeaderboard).catch(() => {});
  }, []);

  useEffect(() => {
    setNickname(stored(NAME_KEY) ?? "");
    api.pool().then(setPool).catch((e: Error) => setError(e.message));
    refreshLeaderboard();
    const saved = stored(RUN_KEY);
    if (saved) {
      api
        .getRun(saved)
        .then((r) => {
          if (r.finished) return store(RUN_KEY, null);
          setRun(r);
          setViewIndex(r.rounds.find((x) => x.status === "playing")?.index ?? 0);
        })
        .catch(() => store(RUN_KEY, null));
    }
  }, [refreshLeaderboard]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const name = nickname.trim();
      store(NAME_KEY, name || null);
      const r = await api.createRun(name || undefined);
      store(RUN_KEY, r.runId);
      setRun(r);
      setViewIndex(0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onRunChange = useCallback(
    (r: RunState) => {
      setRun(r);
      if (r.finished) {
        store(RUN_KEY, null);
        refreshLeaderboard();
      }
    },
    [refreshLeaderboard],
  );

  const round = run?.rounds[viewIndex];
  const showSummary = run && run.finished && viewIndex >= RUN_LENGTH;

  return (
    <main className="shell">
      <header className="topbar">
        <button
          className="brand"
          type="button"
          onClick={() => {
            if (run?.finished) setRun(null);
          }}
        >
          <span className="brand-mark" aria-hidden="true">
            <i /> <i /> <i /> <i />
          </span>
          Split Second
        </button>
        {run && (
          <div className="run-status">
            <ol className="dots" aria-label="Songs in this run">
              {run.rounds.map((r) => (
                <li
                  key={r.roundId}
                  className={`dot is-${r.status}${r.index === viewIndex ? " is-current" : ""}`}
                  aria-label={`Song ${r.index + 1}: ${r.status.replace("_", " ")}`}
                />
              ))}
            </ol>
            <div className="total">
              <span className="total-label">Score</span>
              <span className="total-value" data-testid="total">
                {fmt(run.totalScore)}
              </span>
            </div>
          </div>
        )}
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!run && (
        <Lobby
          nickname={nickname}
          onNickname={setNickname}
          onStart={start}
          busy={busy}
          poolSize={pool?.length ?? null}
          leaderboard={leaderboard}
        />
      )}

      {run && !showSummary && round && pool && (
        <RoundView
          key={round.roundId}
          round={round}
          pool={pool}
          isLast={viewIndex === RUN_LENGTH - 1}
          onRunChange={onRunChange}
          onError={setError}
          onNext={() => {
            setError(null);
            setViewIndex((i) => i + 1);
          }}
        />
      )}

      {run && showSummary && (
        <Summary
          run={run}
          leaderboard={leaderboard}
          onAgain={() => {
            setRun(null);
            setViewIndex(0);
          }}
        />
      )}
    </main>
  );
}

function Lobby(props: {
  nickname: string;
  onNickname: (v: string) => void;
  onStart: () => void;
  busy: boolean;
  poolSize: number | null;
  leaderboard: LeaderboardEntry[];
}) {
  const empty = props.poolSize !== null && props.poolSize < RUN_LENGTH;
  return (
    <section className="lobby">
      <h1>
        Name the song in <em>a split second</em>.
      </h1>
      <p className="lede">
        Five songs, easy to hard. Each starts at {formatSeconds(0.1)}. Unlock more if you need it, but every extra
        moment costs points, and so does every wrong guess.
      </p>
      <form
        className="start"
        onSubmit={(e) => {
          e.preventDefault();
          props.onStart();
        }}
      >
        <input
          className="name-input"
          value={props.nickname}
          onChange={(e) => props.onNickname(e.target.value)}
          maxLength={24}
          placeholder="Name for the leaderboard (optional)"
          aria-label="Name for the leaderboard"
        />
        <button className="btn btn-primary" type="submit" disabled={props.busy || empty || props.poolSize === null}>
          {props.busy ? "Starting…" : "Start a run"}
        </button>
      </form>
      {empty && (
        <p className="hint">
          The song pool is empty. Run <code>pnpm db:seed</code> to fill it from Deezer.
        </p>
      )}
      <ul className="rules">
        <li>
          <b>{fmt(basePoints(0.1))}</b> points at {formatSeconds(0.1)}
        </li>
        <li>
          <b>{fmt(basePoints(1))}</b> at 1s
        </li>
        <li>
          <b>{fmt(basePoints(MAX_SECONDS))}</b> at the full {MAX_SECONDS}s
        </li>
        <li>
          <b>−{WRONG_GUESS_PENALTY}</b> per wrong guess
        </li>
      </ul>
      <Leaderboard entries={props.leaderboard} />
    </section>
  );
}

function Leaderboard({ entries, highlight }: { entries: LeaderboardEntry[]; highlight?: string }) {
  if (entries.length === 0) return null;
  return (
    <section className="board">
      <h2>Best runs</h2>
      <ol>
        {entries.map((e, i) => (
          <li key={e.runId} className={e.runId === highlight ? "is-you" : undefined}>
            <span className="board-rank">{i + 1}</span>
            <span className="board-name">{e.nickname}</span>
            <span className="board-score">{fmt(e.totalScore)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function RoundView(props: {
  round: RoundState;
  pool: PoolTrack[];
  isLast: boolean;
  onRunChange: (run: RunState) => void;
  onError: (message: string | null) => void;
  onNext: () => void;
}) {
  const { pool, onRunChange, onError } = props;
  const [round, setRound] = useState(props.round);
  const [selected, setSelected] = useState(props.round.unlockedSeconds);
  /** False until the first play, so the opening 0.1s shows as not yet heard. */
  const [heard, setHeard] = useState(props.round.unlockedSeconds > 0.1 || props.round.wrongGuesses > 0);
  const [wrong, setWrong] = useState<PoolTrack[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);

  const player = useRef<SnippetPlayer | null>(null);
  const clip = useRef<{ clip: LoadedClip; seconds: number } | null>(null);
  const raf = useRef(0);
  const token = useRef(0);

  useEffect(() => {
    player.current = new SnippetPlayer();
    return () => {
      token.current++;
      cancelAnimationFrame(raf.current);
      player.current?.stop();
    };
  }, []);

  const over = round.status !== "playing";
  const playSeconds = over ? MAX_SECONDS : selected;

  const stop = useCallback(() => {
    token.current++;
    cancelAnimationFrame(raf.current);
    player.current?.stop();
    setProgress(null);
  }, []);

  const play = useCallback(async () => {
    const p = player.current!;
    if (progress !== null) return stop();
    const mine = ++token.current;
    onError(null);
    try {
      let current = round;
      if (!over && selected > round.unlockedSeconds) {
        setLoading(true);
        current = await api.unlock(round.roundId, selected);
        setRound(current);
      }
      const need = over ? MAX_SECONDS : current.unlockedSeconds;
      if (!clip.current || clip.current.seconds < need) {
        setLoading(true);
        const data = await api.audio(round.roundId);
        clip.current = { clip: await p.decode(data), seconds: need };
      }
      setLoading(false);
      if (mine !== token.current) return;
      setHeard(true);
      const length = Math.min(need, clip.current.clip.seconds);
      setProgress(0);
      await p.play(clip.current.clip, length, (startedAt, ctx) => {
        const tick = () => {
          if (mine !== token.current) return;
          setProgress(Math.min(1, Math.max(0, (ctx.currentTime - startedAt) / length)));
          raf.current = requestAnimationFrame(tick);
        };
        raf.current = requestAnimationFrame(tick);
      });
      if (mine === token.current) {
        cancelAnimationFrame(raf.current);
        setProgress(null);
      }
    } catch (e) {
      setLoading(false);
      setProgress(null);
      onError((e as Error).message);
    }
  }, [onError, over, progress, round, selected, stop]);

  const finish = useCallback(
    (next: RoundState, run: RunState) => {
      stop();
      clip.current = null; // the full preview is available now
      setRound(next);
      onRunChange(run);
    },
    [onRunChange, stop],
  );

  const guess = async (track: PoolTrack) => {
    onError(null);
    try {
      const res = await api.guess(round.roundId, track.id);
      if (res.correct) return finish(res.round, res.run);
      setRound(res.round);
      setWrong((w) => (w.some((t) => t.id === track.id) ? w : [...w, track]));
      setShake(true);
      setTimeout(() => setShake(false), 400);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const giveUp = async () => {
    onError(null);
    try {
      const res = await api.giveUp(round.roundId);
      finish(res.round, res.run);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const excluded = useMemo(() => new Set(wrong.map((t) => t.id)), [wrong]);
  const onOffer = scoreRound(selected, round.wrongGuesses);
  const playing = progress !== null;
  const extending = !over && selected > round.unlockedSeconds;

  return (
    <section className={`round${shake ? " is-shaking" : ""}`}>
      <p className="eyebrow">
        Song {round.index + 1} of {RUN_LENGTH}
      </p>

      {!over && (
        <>
          <div className="offer">
            <div>
              <span className="offer-label">Clip length</span>
              <span className="offer-value" data-testid="length">
                {formatSeconds(selected)}
              </span>
            </div>
            <div className="offer-right">
              <span className="offer-label">A correct guess is worth</span>
              <span className="offer-value is-points" data-testid="offer">
                {fmt(onOffer)}
              </span>
            </div>
          </div>

          <div className="deck">
            <button
              type="button"
              className={`play${playing ? " is-playing" : ""}`}
              onClick={play}
              disabled={loading}
              aria-label={playing ? "Stop" : `Play ${formatSeconds(selected)}`}
            >
              {loading ? <span className="spinner" /> : playing ? <StopIcon /> : <PlayIcon />}
            </button>
            <Scrubber
              unlocked={heard ? round.unlockedSeconds : 0.1}
              selected={selected}
              progress={progress}
              onSelect={setSelected}
            />
          </div>
          <p className="deck-hint">
            {extending
              ? `Press play to unlock ${formatSeconds(selected)}. You can't go back down.`
              : heard
                ? "Drag right to hear more. Longer clips are worth less."
                : "Press play to hear the first tenth of a second."}
          </p>

          <GuessInput pool={pool} excluded={excluded} onGuess={guess} />

          {wrong.length > 0 && (
            <ul className="wrong" aria-label="Wrong guesses">
              {wrong.map((t) => (
                <li key={t.id}>
                  <span>
                    {t.title} <i>{t.artist}</i>
                  </span>
                  <b>−{WRONG_GUESS_PENALTY}</b>
                </li>
              ))}
            </ul>
          )}

          <button type="button" className="btn btn-quiet" onClick={giveUp}>
            Give up on this song
          </button>
        </>
      )}

      {over && round.answer && (
        <div className="reveal" data-testid="reveal">
          <div className="cover">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {round.answer.coverUrl ? <img src={round.answer.coverUrl} alt="" /> : <span aria-hidden="true">♪</span>}
          </div>
          <div className="reveal-body">
            <p className={`verdict is-${round.status}`}>
              {round.status === "solved" ? `Got it at ${formatSeconds(round.unlockedSeconds)}` : "Not this time"}
            </p>
            <h2>{round.answer.title}</h2>
            <p className="reveal-artist">{round.answer.artist}</p>
            <p className="reveal-score">
              <b>+{fmt(round.score ?? 0)}</b>
              {round.wrongGuesses > 0 && round.status === "solved" && (
                <span>
                  {" "}
                  after {round.wrongGuesses} wrong {round.wrongGuesses === 1 ? "guess" : "guesses"}
                </span>
              )}
            </p>
            <div className="reveal-actions">
              <button type="button" className="btn" onClick={play} disabled={loading}>
                {playing ? "Stop" : loading ? "Loading…" : "Hear the preview"}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                autoFocus
                onClick={() => {
                  stop();
                  props.onNext();
                }}
              >
                {props.isLast ? "See your score" : "Next song"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Summary({
  run,
  leaderboard,
  onAgain,
}: {
  run: RunState;
  leaderboard: LeaderboardEntry[];
  onAgain: () => void;
}) {
  const solved = run.rounds.filter((r) => r.status === "solved").length;
  return (
    <section className="summary">
      <p className="eyebrow">Run complete</p>
      <h1 className="summary-score" data-testid="final">
        {fmt(run.totalScore)}
      </h1>
      <p className="lede">
        {solved} of {RUN_LENGTH} songs named.
      </p>
      <ol className="recap">
        {run.rounds.map((r) => (
          <li key={r.roundId} className={`is-${r.status}`}>
            <span className="recap-song">
              {r.answer?.title} <i>{r.answer?.artist}</i>
            </span>
            <span className="recap-at">{r.status === "solved" ? formatSeconds(r.unlockedSeconds) : "missed"}</span>
            <span className="recap-score">{fmt(r.score ?? 0)}</span>
          </li>
        ))}
      </ol>
      <button type="button" className="btn btn-primary" onClick={onAgain} autoFocus>
        Play again
      </button>
      <Leaderboard entries={leaderboard} highlight={run.runId} />
    </section>
  );
}

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
    <path d="M8 5.2v13.6a1 1 0 0 0 1.5.86l11-6.8a1 1 0 0 0 0-1.72l-11-6.8A1 1 0 0 0 8 5.2z" fill="currentColor" />
  </svg>
);
const StopIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
  </svg>
);
