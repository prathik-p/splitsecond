"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";
import { normalizeTitle, type PoolTrack } from "@splitsecond/shared";

interface Props {
  pool: PoolTrack[];
  /** Track ids already guessed wrong this round, hidden from suggestions. */
  excluded: Set<string>;
  disabled?: boolean;
  onGuess: (track: PoolTrack) => void;
}

interface Indexed extends PoolTrack {
  normTitle: string;
  normArtist: string;
}

export function GuessInput({ pool, excluded, disabled, onGuess }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);

  const fuse = useMemo(() => {
    const items: Indexed[] = pool.map((t) => ({
      ...t,
      normTitle: normalizeTitle(t.title),
      normArtist: normalizeTitle(t.artist),
    }));
    return new Fuse(items, {
      keys: [
        { name: "normTitle", weight: 0.7 },
        { name: "normArtist", weight: 0.3 },
      ],
      threshold: 0.35,
      ignoreLocation: true,
      minMatchCharLength: 1,
    });
  }, [pool]);

  const results = useMemo(() => {
    const q = normalizeTitle(query);
    if (!q) return [];
    return fuse
      .search(q, { limit: 12 })
      .map((r) => r.item)
      .filter((t) => !excluded.has(t.id))
      .slice(0, 7);
  }, [fuse, query, excluded]);

  useEffect(() => setActive(0), [query]);

  const choose = (track: PoolTrack) => {
    setQuery("");
    setOpen(false);
    onGuess(track);
    input.current?.focus();
  };

  const showList = open && query.trim().length > 0;

  return (
    <div className="guess">
      <input
        ref={input}
        className="guess-input"
        type="text"
        value={query}
        disabled={disabled}
        placeholder="Type a song title or artist"
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-label="Your guess"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(results.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && showList && results[active]) {
            e.preventDefault();
            choose(results[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {showList && (
        <ul className="guess-list" id={listId} role="listbox">
          {results.length === 0 && <li className="guess-empty">No song in the pool matches that.</li>}
          {results.map((t, i) => (
            <li
              key={t.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`guess-option${i === active ? " is-active" : ""}`}
              // mousedown, so the pick lands before the input's blur closes the list
              onMouseDown={(e) => {
                e.preventDefault();
                choose(t);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="guess-title">{t.title}</span>
              <span className="guess-artist">{t.artist}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
