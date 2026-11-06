import type { WavAudio } from "./wav.ts";

/**
 * Audio -> mouth-open keyframes. No model, no phonemes, no viseme set: M2 only
 * needs the renderer to know how far the mouth is open at each frame, and RMS
 * energy is enough for that. The viseme layer (which shape, not just how open)
 * belongs to M3, where it can be driven by the same envelope plus the text.
 */

export interface MouthFrame {
  /** Milliseconds from the start of the clip. */
  at: number;
  /** 0 = closed, 1 = wide open. */
  open: number;
}

export interface EnvelopeOptions {
  /** Keyframes per second. 60 is enough for any renderer and cheap to store. */
  fps?: number;
  /** Fraction of peak energy treated as silence. Default 0.08. */
  noiseFloor?: number;
  /** Extra multiplier before the curve. Default 1. */
  gain?: number;
  /** Per-frame rise coefficient (0..1). Higher = snappier. Default 0.35. */
  attack?: number;
  /** Per-frame fall coefficient (0..1). Lower = longer decay. Default 0.12. */
  release?: number;
  /** Exponent applied before smoothing; <1 lifts quiet speech. Default 0.75. */
  curve?: number;
}

export interface EnvelopeStats {
  frames: number;
  durationMs: number;
  voicedFrames: number;
  peakOpen: number;
  speechRatio: number;
}

/** Below this, a decaying curve is treated as fully shut. */
const DEADBAND = 0.01;

const DEFAULTS = {
  fps: 60,
  noiseFloor: 0.08,
  gain: 1,
  attack: 0.35,
  release: 0.12,
  curve: 0.75,
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Non-overlapping RMS windows, one per output frame. */
export function rmsWindows(samples: Float32Array, sampleRate: number, fps: number): number[] {
  const window = Math.max(1, Math.round(sampleRate / fps));
  const count = Math.floor(samples.length / window);
  const out: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    const base = i * window;
    for (let j = 0; j < window; j++) {
      const s = samples[base + j];
      sum += s * s;
    }
    out[i] = Math.sqrt(sum / window);
  }
  return out;
}

export function mouthFrames(audio: WavAudio, opts: EnvelopeOptions = {}): MouthFrame[] {
  const fps = clamp(opts.fps ?? DEFAULTS.fps, 10, 120);
  const window = Math.max(1, Math.round(audio.sampleRate / fps));
  const count = Math.floor(audio.samples.length / window);
  if (count === 0) return [];

  const raw = rmsWindows(audio.samples, audio.sampleRate, fps);
  let peak = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] > peak) peak = raw[i];

  const step = 1000 / fps;
  const frames: MouthFrame[] = new Array(count);
  if (peak <= 1e-6) {
    for (let i = 0; i < count; i++) frames[i] = { at: Math.round(i * step), open: 0 };
    return frames;
  }

  const floor = clamp(opts.noiseFloor ?? DEFAULTS.noiseFloor, 0, 0.9) * peak;
  const gain = opts.gain ?? DEFAULTS.gain;
  const attack = clamp(opts.attack ?? DEFAULTS.attack, 0.01, 1);
  const release = clamp(opts.release ?? DEFAULTS.release, 0.01, 1);
  const curve = opts.curve ?? DEFAULTS.curve;
  const span = Math.max(peak - floor, 1e-9);

  let v = 0;
  for (let i = 0; i < count; i++) {
    const target = raw[i] <= floor ? 0 : clamp(Math.pow((raw[i] - floor) / span, curve) * gain, 0, 1);
    v += (target - v) * (target > v ? attack : release);
    // Exponential release only approaches zero. Snapping the last sliver shut
    // keeps a silent passage at exactly 0 instead of an invisible 0.003, which
    // matters because renderers key "closed" off an exact value.
    if (target === 0 && v < DEADBAND) v = 0;
    frames[i] = { at: Math.round(i * step), open: Math.round(clamp(v, 0, 1) * 1000) / 1000 };
  }
  return frames;
}

export function envelopeStats(frames: MouthFrame[], durationMs: number): EnvelopeStats {
  let voiced = 0;
  let peakOpen = 0;
  for (const f of frames) {
    if (f.open > 0.1) voiced++;
    if (f.open > peakOpen) peakOpen = f.open;
  }
  return {
    frames: frames.length,
    durationMs: Math.round(durationMs),
    voicedFrames: voiced,
    peakOpen,
    speechRatio: frames.length ? Math.round((voiced / frames.length) * 1000) / 1000 : 0,
  };
}
