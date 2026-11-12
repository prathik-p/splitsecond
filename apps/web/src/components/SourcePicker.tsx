"use client";

import { useState } from "react";
import { RUN_LENGTH, type PoolSummary, type ProfileState } from "@splitsecond/shared";

interface Props {
  /** What the default pool holds, or null while loading. */
  hits: PoolSummary | null;
  profiles: ProfileState[];
  /** Selected profile id, or null for the default pool. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Starts an import; resolves true if it was accepted. */
  onImport: (username: string, refresh?: boolean) => Promise<boolean>;
}

const songs = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "song" : "songs"}`;

function describe(p: ProfileState): string {
  if (p.status === "running" || p.status === "pending") {
    return p.total > 0 ? `Matching ${p.processed} of ${p.total}…` : "Reading Last.fm…";
  }
  if (p.status === "failed") return "Import failed";
  return songs(p.matched);
}

/** Choose where a run's songs come from: the hits pool, or a Last.fm listener's own music. */
export function SourcePicker({ hits, profiles, selectedId, onSelect, onImport }: Props) {
  const [username, setUsername] = useState("");
  const [adding, setAdding] = useState(false);
  const selected = profiles.find((p) => p.id === selectedId) ?? null;

  const add = async () => {
    const name = username.trim();
    if (!name || adding) return;
    setAdding(true);
    if (await onImport(name)) setUsername("");
    setAdding(false);
  };

  let note: React.ReactNode = null;
  if (!selected) {
    if (hits !== null && hits.songs < RUN_LENGTH) {
      note = (
        <>
          The song pool is empty. Run <code>pnpm db:seed</code> to fill it from Deezer.
        </>
      );
    }
  } else if (selected.status === "failed") {
    note = selected.error ?? "The import failed.";
  } else if (selected.status === "done" && selected.total === 0) {
    note = `${selected.displayName} has no listening history on Last.fm yet.`;
  } else if (selected.status === "done" && selected.matched < RUN_LENGTH) {
    note = `Only ${songs(selected.matched)} from ${selected.displayName} could be matched. A run needs ${RUN_LENGTH}.`;
  } else if (selected.status === "done") {
    note = `${selected.matched} of ${selected.displayName}'s ${selected.total} top and loved songs are playable.`;
  } else {
    note = "You can start as soon as the import finishes.";
  }
  const canRetry = selected && (selected.status === "done" || selected.status === "failed");

  return (
    <section className="sources" aria-labelledby="sources-title">
      <h2 id="sources-title">Songs from</h2>
      <div className="source-list" role="radiogroup" aria-labelledby="sources-title">
        <button
          type="button"
          role="radio"
          aria-checked={selectedId === null}
          className={`source${selectedId === null ? " is-selected" : ""}`}
          onClick={() => onSelect(null)}
        >
          <span className="source-name">
            {hits?.yearFrom && hits.yearTo && hits.yearFrom !== hits.yearTo
              ? `Hits ${hits.yearFrom}–${hits.yearTo}`
              : "Top hits"}
          </span>
          <span className="source-meta">{hits === null ? "Loading…" : songs(hits.songs)}</span>
        </button>
        {profiles.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={selectedId === p.id}
            className={`source is-${p.status}${selectedId === p.id ? " is-selected" : ""}`}
            onClick={() => onSelect(p.id)}
          >
            <span className="source-name">{p.displayName}</span>
            <span className="source-meta">{describe(p)}</span>
            {(p.status === "running" || p.status === "pending") && (
              <span
                className="source-progress"
                style={{ width: `${p.total ? Math.round((p.processed / p.total) * 100) : 4}%` }}
              />
            )}
          </button>
        ))}
      </div>

      {note && (
        <p className={`source-note${selected?.status === "failed" ? " is-error" : ""}`} role="status">
          {note}{" "}
          {canRetry && (
            <button type="button" className="link" onClick={() => onImport(selected.displayName, true)}>
              {selected.status === "failed" ? "Try again" : "Re-import"}
            </button>
          )}
        </p>
      )}

      <form
        className="source-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          className="name-input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          maxLength={15}
          placeholder="Add a Last.fm username"
          aria-label="Last.fm username"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <button className="btn" type="submit" disabled={adding || !username.trim()}>
          {adding ? "Checking…" : "Add profile"}
        </button>
      </form>
    </section>
  );
}
