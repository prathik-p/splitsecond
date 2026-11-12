"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_SECONDS,
  RUN_LENGTH,
  WRONG_GUESS_PENALTY,
  basePoints,
  formatSeconds,
  scoreRound,
  type PoolSummary,
  type PoolTrack,
  type ProfileState,
  type RoundState,
  type RunState,
} from "@splitsecond/shared";
import { api } from "@/lib/api";
import { HITS, getBest, recordRun, type Best } from "@/lib/best";
import { SnippetPlayer, type LoadedClip } from "@/lib/snippet-player";
import { Scrubber } from "./Scrubber";
import { GuessInput } from "./GuessInput";
import { SourcePicker } from "./SourcePicker";

const RUN_KEY = "splitsecond.run";
const SOURCE_KEY = "splitsecond.source";
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
  /** Songs that can be guessed in the current run. */
  const [pool, setPool] = useState<PoolTrack[] | null>(null);
  /** What the default pool holds, for the lobby. */
  const [hits, setHits] = useState<PoolSummary | null>(null);
  const [profiles, setProfiles] = useState<ProfileState[]>([]);
  /** Selected profile id, or null for the default pool. */
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  /** True once we are in the browser, where the stored best can be read. */
  const [mounted, setMounted] = useState(false);
  /** How the run that just finished compares to the best before it. */
  const [outcome, setOutcome] = useState<{ best: Best; isNew: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Index of the round on screen. Stays on a finished round until "Next". */
  const [viewIndex, setViewIndex] = useState(0);

  useEffect(() => {
    setMounted(true);
    api
      .poolSummary()
      .then(setHits)
      .catch((e: Error) => setError(e.message));
    api
      .profiles()
      .then((list) => {
        setProfiles(list);
        const saved = stored(SOURCE_KEY);
        if (saved && list.some((p) => p.id === saved)) setSourceId(saved);
      })
      .catch(() => {});
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
  }, []);


  // Each run has its own guessable songs.
  const runId = run?.runId;
  useEffect(() => {
    if (!runId) return;
    setPool(null);
    api.runPool(runId).then(setPool).catch((e: Error) => setError(e.message));
  }, [runId]);

  // Follow imports that are in progress.
  const importing = profiles.filter((p) => p.status === "running" || p.status === "pending").map((p) => p.id);
  const importingKey = importing.join(",");
  useEffect(() => {
    if (!importingKey) return;
    const ids = importingKey.split(",");
    const timer = setInterval(() => {
      for (const id of ids) {
        api
          .profile(id)
          .then((fresh) => setProfiles((list) => list.map((p) => (p.id === fresh.id ? fresh : p))))
          .catch(() => {});
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [importingKey]);

  const selectSource = (id: string | null) => {
    setSourceId(id);
    store(SOURCE_KEY, id);
    setError(null);
  };

  const importProfile = async (username: string, refresh = false) => {
    setError(null);
    try {
      const profile = await api.importProfile(username, refresh);
      setProfiles((list) => [profile, ...list.filter((p) => p.id !== profile.id)]);
      selectSource(profile.id);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createRun(sourceId);
      store(RUN_KEY, r.runId);
      setOutcome(null);
      setRun(r);
      setViewIndex(0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onRunChange = useCallback((r: RunState) => {
    setRun(r);
    if (r.finished) {
      store(RUN_KEY, null);
      setOutcome(recordRun(r.source?.profileId ?? HITS, r.runId, r.totalScore));
    }
  }, []);

  const selected = profiles.find((p) => p.id === sourceId) ?? null;
  // Personal best for the selected source, read from this browser on each lobby render.
  const best: Best | null = mounted && !run ? getBest(sourceId ?? HITS) : null;
  const playable = selected ? selected.status === "done" && selected.matched >= RUN_LENGTH : (hits?.songs ?? 0) >= RUN_LENGTH;

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
          onStart={start}
          busy={busy}
          playable={playable}
          hits={hits}
          profiles={profiles}
          sourceId={sourceId}
          onSelectSource={selectSource}
          onImport={importProfile}
          best={best}
        />
      )}

      {run && !showSummary && round && pool && (
        <RoundView
          key={round.roundId}
          round={round}
          pool={pool}
          sourceLabel={run.source ? `${run.source.displayName}'s Last.fm` : null}
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
          outcome={outcome}
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
  onStart: () => void;
  busy: boolean;
  playable: boolean;
  hits: PoolSummary | null;
  profiles: ProfileState[];
  sourceId: string | null;
  onSelectSource: (id: string | null) => void;
  onImport: (username: string, refresh?: boolean) => Promise<boolean>;
  best: Best | null;
}) {
  return (
    <section className="lobby">
      <h1>
        Name the song in <em>a split second</em>.
      </h1>
      <p className="lede">
        Five songs, easy to hard. Each starts at {formatSeconds(0.1)}. Unlock more if you need it, but every extra
        moment costs points, and so does every wrong guess.
      </p>
      <SourcePicker
        hits={props.hits}
        profiles={props.profiles}
        selectedId={props.sourceId}
        onSelect={props.onSelectSource}
        onImport={props.onImport}
      />
      <div className="start">
        <button
          className="btn btn-primary btn-big"
          type="button"
          onClick={props.onStart}
          disabled={props.busy || !props.playable}
        >
          {props.busy ? "Starting…" : "Start a run"}
        </button>
        <p className="best" data-testid="best">
          {props.best ? (
            <>
              <span className="best-label">Your best</span>
              <b>{fmt(props.best.score)}</b>
              <span className="best-meta">
                {props.best.runs} {props.best.runs === 1 ? "run" : "runs"} played
              </span>
            </>
          ) : (
            <span className="best-meta">No runs yet. Your best score is kept on this device.</span>
          )}
        </p>
      </div>
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
    </section>
  );
}

function RoundView(props: {
  round: RoundState;
  pool: PoolTrack[];
  sourceLabel: string | null;
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
        {props.sourceLabel && <span className="eyebrow-source"> · {props.sourceLabel}</span>}
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
            <p className="reveal-artist">
              {round.answer.artist}
              {round.answer.year ? ` · ${round.answer.year}` : ""}
            </p>
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
  outcome,
  onAgain,
}: {
  run: RunState;
  outcome: { best: Best; isNew: boolean } | null;
  onAgain: () => void;
}) {
  const solved = run.rounds.filter((r) => r.status === "solved").length;
  const newBest = outcome?.isNew && run.totalScore > 0;
  return (
    <section className="summary">
      <p className={`eyebrow${newBest ? " is-record" : ""}`} data-testid="verdict">
        {newBest ? "New high score" : "Run complete"}
      </p>
      <h1 className="summary-score" data-testid="final">
        {fmt(run.totalScore)}
      </h1>
      <p className="lede">
        {solved} of {RUN_LENGTH} songs named.
        {outcome && !newBest && ` Your best is ${fmt(outcome.best.score)}.`}
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
