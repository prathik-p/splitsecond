/**
 * Plays exact-length clips with the Web Audio API.
 *
 * The clip is decoded into an AudioBuffer and started with
 * source.start(when, offset, duration), which is sample-accurate, unlike an
 * <audio> element stopped by a timer. A short gain ramp at each end avoids
 * the click you get from cutting a waveform mid-cycle.
 */

const FADE_SECONDS = 0.008;
/** Decoders emit a few ms of silence before the first real sample. */
const MAX_LEAD_IN_SECONDS = 0.06;

export interface LoadedClip {
  buffer: AudioBuffer;
  /** Where the audible audio starts in the buffer. */
  offset: number;
  /** Audible seconds available from `offset`. */
  seconds: number;
}

/** One audio context for the whole page: once a click has unlocked it, it stays unlocked. */
let shared: AudioContext | null = null;

export class SnippetPlayer {
  private current: { source: AudioBufferSourceNode; gain: GainNode } | null = null;

  /** Must first be called from a user gesture (browsers block audio otherwise). */
  private context(): AudioContext {
    if (!shared) {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      shared = new Ctor();
    }
    return shared;
  }

  /**
   * Call at the start of a click handler. Browsers only let audio start from a
   * user gesture, and the replay after a round begins after a network call,
   * by which time the gesture is over.
   */
  prime() {
    try {
      const ctx = this.context();
      if (ctx.state === "suspended") void ctx.resume();
    } catch {
      // no Web Audio here; play() will report it
    }
  }

  async decode(data: ArrayBuffer): Promise<LoadedClip> {
    const buffer = await this.context().decodeAudioData(data);
    const offset = leadInSeconds(buffer);
    return { buffer, offset, seconds: buffer.duration - offset };
  }

  /**
   * Play the first `seconds` of the clip. Resolves when playback ends or is stopped.
   * `onStart` receives the AudioContext time playback begins, for progress UI.
   */
  async play(clip: LoadedClip, seconds: number, onStart?: (startedAt: number, ctx: AudioContext) => void) {
    const ctx = this.context();
    if (ctx.state === "suspended") await ctx.resume();
    this.stop();

    const duration = Math.min(seconds, clip.seconds);
    const fade = Math.min(FADE_SECONDS, duration / 4);
    const startAt = ctx.currentTime + 0.03;
    const endAt = startAt + duration;

    const source = ctx.createBufferSource();
    source.buffer = clip.buffer;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(1, startAt + fade);
    gain.gain.setValueAtTime(1, endAt - fade);
    gain.gain.linearRampToValueAtTime(0, endAt);
    source.connect(gain).connect(ctx.destination);

    const entry = { source, gain };
    this.current = entry;
    const ended = new Promise<void>((resolve) => {
      source.onended = () => {
        if (this.current === entry) this.current = null;
        source.disconnect();
        gain.disconnect();
        resolve();
      };
    });
    source.start(startAt, clip.offset, duration);
    onStart?.(startAt, ctx);
    return ended;
  }

  stop() {
    const playing = this.current;
    if (!playing || !shared) return;
    this.current = null;
    const now = shared.currentTime;
    try {
      playing.gain.gain.cancelScheduledValues(now);
      playing.gain.gain.setValueAtTime(playing.gain.gain.value, now);
      playing.gain.gain.linearRampToValueAtTime(0, now + FADE_SECONDS);
      playing.source.stop(now + FADE_SECONDS);
    } catch {
      // already stopped
    }
  }

  get playing() {
    return this.current !== null;
  }
}

function leadInSeconds(buffer: AudioBuffer): number {
  const limit = Math.min(buffer.length, Math.floor(MAX_LEAD_IN_SECONDS * buffer.sampleRate));
  let first = limit;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < first; i++) {
      if (Math.abs(data[i]) > 1e-4) {
        first = i;
        break;
      }
    }
  }
  // All-silent openings (a quiet intro) are part of the song, not decoder delay.
  return first === limit ? 0 : first / buffer.sampleRate;
}
