"use client";

import { useCallback, useRef } from "react";
import {
  MAX_SECONDS,
  MIN_SECONDS,
  basePoints,
  formatSeconds,
  positionToSeconds,
  secondsToPosition,
  snapSeconds,
} from "@earshot/shared";

const STOPS = [0.1, 0.5, 1, 2, 4, 8, 15, 30];

interface Props {
  /** Length already heard. The handle can't go below it. */
  unlocked: number;
  /** Length the next play will use. */
  selected: number;
  /** 0..1 of `selected` played so far, or null when idle. */
  progress: number | null;
  disabled?: boolean;
  onSelect: (seconds: number) => void;
}

/**
 * Log-scaled length picker: every tenfold increase takes the same width,
 * so 0.1s→1s is as wide as 3s→30s.
 */
export function Scrubber({ unlocked, selected, progress, disabled, onSelect }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const select = useCallback(
    (seconds: number) => onSelect(Math.max(unlocked, snapSeconds(seconds))),
    [onSelect, unlocked],
  );

  const fromPointer = useCallback(
    (clientX: number) => {
      const rect = track.current!.getBoundingClientRect();
      select(positionToSeconds((clientX - rect.left) / rect.width));
    },
    [select],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const pos = secondsToPosition(selected);
    const step = e.shiftKey ? 0.1 : 0.03;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      // Always move at least one snap step, even where steps are wider than the nudge.
      let p = pos + step;
      while (p < 1 && snapSeconds(positionToSeconds(p)) <= selected) p += 0.01;
      next = positionToSeconds(Math.min(1, p));
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      let p = pos - step;
      while (p > 0 && snapSeconds(positionToSeconds(p)) >= selected) p -= 0.01;
      next = positionToSeconds(Math.max(0, p));
    } else if (e.key === "Home") next = unlocked;
    else if (e.key === "End") next = MAX_SECONDS;
    if (next !== null) {
      e.preventDefault();
      select(next);
    }
  };

  const unlockedPct = secondsToPosition(unlocked) * 100;
  const selectedPct = secondsToPosition(selected) * 100;
  const progressPct = progress === null ? null : secondsToPosition(Math.max(MIN_SECONDS, selected * progress)) * 100;

  return (
    <div className={`scrubber${disabled ? " is-disabled" : ""}`}>
      <div
        ref={track}
        className="scrubber-track"
        onPointerDown={(e) => {
          if (disabled) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e.clientX);
        }}
        onPointerMove={(e) => dragging.current && fromPointer(e.clientX)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
      >
        <div className="scrubber-rail" />
        <div className="scrubber-fill is-pending" style={{ width: `${selectedPct}%` }} />
        <div className="scrubber-fill is-unlocked" style={{ width: `${unlockedPct}%` }} />
        {progressPct !== null && <div className="scrubber-playhead" style={{ left: `${progressPct}%` }} />}
        <div
          className="scrubber-handle"
          style={{ left: `${selectedPct}%` }}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="Clip length"
          aria-valuemin={MIN_SECONDS}
          aria-valuemax={MAX_SECONDS}
          aria-valuenow={selected}
          aria-valuetext={`${formatSeconds(selected)}, worth ${basePoints(selected).toLocaleString("en-US")} points`}
          aria-disabled={disabled}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="scrubber-stops">
        {STOPS.map((s) => (
          <button
            key={s}
            type="button"
            className={`scrubber-stop${s <= unlocked ? " is-heard" : ""}`}
            style={{ left: `${secondsToPosition(s) * 100}%` }}
            disabled={disabled || s < unlocked}
            onClick={() => select(s)}
            tabIndex={-1}
          >
            {formatSeconds(s)}
          </button>
        ))}
      </div>
    </div>
  );
}
