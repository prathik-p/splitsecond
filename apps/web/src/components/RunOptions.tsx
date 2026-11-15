"use client";

import { useMemo, useState } from "react";
import { RUN_LENGTH, type PoolOptions, type RunFilters } from "@splitsecond/shared";
import { describeFilters, fold, matchingSongs, songsInGenres } from "@/lib/run-options";

interface Props {
  options: PoolOptions;
  value: RunFilters;
  onChange: (next: RunFilters) => void;
}

/** How many artists to list at once. Searching narrows it down past that. */
const LIST_LIMIT = 80;
const count = (n: number) => n.toLocaleString("en-US");

const toggled = (list: string[], name: string) =>
  list.includes(name) ? list.filter((n) => n !== name) : [...list, name];

/** Narrow a run to chosen genres and artists. Nothing chosen means everything. */
export function RunOptions({ options, value, onChange }: Props) {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");

  const genreCounts = useMemo(() => {
    const counts = options.genres.map(() => 0);
    // Hits only: a genre on its own doesn't bring in deep cuts.
    for (const s of options.songs) if (s.g >= 0 && !s.d) counts[s.g]++;
    return counts;
  }, [options]);

  // Artists are counted within the chosen genres, so the list shows who can actually come up.
  // Picking an artist brings in their whole catalogue, so deep cuts count here.
  const artists = useMemo(() => {
    const counts = new Map<number, number>();
    for (const s of songsInGenres(options, value.genres)) {
      for (const a of s.a) counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    return [...counts]
      .map(([i, songs]) => ({ name: options.artists[i], songs }))
      .sort((a, b) => b.songs - a.songs || a.name.localeCompare(b.name));
  }, [options, value.genres]);

  const wanted = fold(query.trim());
  const found = wanted ? artists.filter((a) => fold(a.name).includes(wanted)) : artists;
  const listed = found.slice(0, LIST_LIMIT);
  const matching = matchingSongs(options, value).length;

  return (
    <section className={`options${open ? " is-open" : ""}`} aria-labelledby="options-title">
      <button
        type="button"
        className="options-head"
        aria-expanded={open}
        aria-controls="options-body"
        onClick={() => setOpen((o) => !o)}
      >
        <h2 id="options-title">Run options</h2>
        <span className="options-summary" data-testid="options-summary">
          {describeFilters(value)}
        </span>
        <span className="options-chevron" aria-hidden="true" />
      </button>

      {open && (
        <div id="options-body" className="options-body">
          {options.genres.length > 0 ? (
            <div className="options-group">
              <h3 id="genre-title">Genre</h3>
              <div className="chips" role="group" aria-labelledby="genre-title">
                <button
                  type="button"
                  className={`chip${value.genres.length === 0 ? " is-on" : ""}`}
                  aria-pressed={value.genres.length === 0}
                  onClick={() => onChange({ ...value, genres: [] })}
                >
                  All genres
                </button>
                {options.genres.map((genre, i) => (
                  <button
                    key={genre}
                    type="button"
                    className={`chip${value.genres.includes(genre) ? " is-on" : ""}`}
                    aria-pressed={value.genres.includes(genre)}
                    onClick={() => onChange({ ...value, genres: toggled(value.genres, genre) })}
                  >
                    {genre} <span className="chip-count">{count(genreCounts[i])}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <p className="options-note">
              Genres show up here after the next <code>pnpm db:seed</code>.
            </p>
          )}

          <div className="options-group">
            <h3 id="artist-title">Artists</h3>
            <div className="artist-search">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${count(artists.length)} artists`}
                aria-label="Search artists"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="chips" role="group" aria-label="Chosen artists">
              <button
                type="button"
                className={`chip${value.artists.length === 0 ? " is-on" : ""}`}
                aria-pressed={value.artists.length === 0}
                onClick={() => onChange({ ...value, artists: [] })}
              >
                All artists
              </button>
              {value.artists.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="chip is-on"
                  aria-label={`Remove ${name}`}
                  onClick={() => onChange({ ...value, artists: toggled(value.artists, name) })}
                >
                  {name} <span className="chip-x" aria-hidden="true">×</span>
                </button>
              ))}
            </div>
            <ul className="artist-list" aria-labelledby="artist-title">
              {listed.map((a) => {
                const on = value.artists.includes(a.name);
                return (
                  <li key={a.name}>
                    <button
                      type="button"
                      className={`artist${on ? " is-on" : ""}`}
                      aria-pressed={on}
                      onClick={() => onChange({ ...value, artists: toggled(value.artists, a.name) })}
                    >
                      <span className="artist-name">{a.name}</span>
                      <span className="artist-count">{count(a.songs)}</span>
                    </button>
                  </li>
                );
              })}
              {listed.length === 0 && <li className="artist-empty">No artist matches “{query.trim()}”.</li>}
              {found.length > listed.length && (
                <li className="artist-empty">
                  {count(found.length - listed.length)} more. Search to find someone further down.
                </li>
              )}
            </ul>
          </div>

          <p className={`options-match${matching < RUN_LENGTH ? " is-short" : ""}`} role="status" data-testid="options-match">
            {matching < RUN_LENGTH
              ? `Only ${count(matching)} ${matching === 1 ? "song matches" : "songs match"}. A run needs ${RUN_LENGTH}, so pick more genres or artists.`
              : `${count(matching)} songs match`}
          </p>
        </div>
      )}
    </section>
  );
}
