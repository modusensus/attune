import { resample, type WavAudio } from "../audio/wav.ts";

export { resample };

/**
 * Audio -> a stream of frames the listening layer can reason about.
 *
 * Two numbers per frame, and both are load-bearing:
 *
 *   rms  tells you *that* someone is talking (this is what VAD gives you).
 *   f0   tells you *how they are talking* — whether the phrase is landing or
 *        still climbing. VAD cannot see the difference between a sentence that
 *        ended and one that paused, and that difference is the entire reason
 *        this project exists.
 *
 * Pitch tracking is autocorrelation on a decimated window. Decimating to ~6 kHz
 * cuts the lag search by 16x without hurting F0 for speech (70-400 Hz). No FFT,
 * no model, no dependency.
 *
 * There is one framer, not two. Live audio arrives in chunks and a recording
 * arrives all at once, and if those two paths cut frames differently then the
 * live listener and the offline judge disagree — which makes every offline test
 * a lie about live behaviour. `Framer` is streaming; `framesFromWav` is the same
 * object with the whole clip pushed in.
 */

export interface AudioFrame {
  /** Milliseconds from the start of the stream. */
  at: number;
  /** Root-mean-square amplitude of the window, 0..1. */
  rms: number;
  /** Fundamental frequency in Hz, 0 when the window is unvoiced. */
  f0: number;
  /** True when periodicity clears the voicing threshold. */
  voiced: boolean;
  /** 16 kHz mono slice of this window. Only when `withPcm` is set. */
  pcm?: Float32Array;
}

export interface FrameOptions {
  /** Frames per second. Default 50 (a 20 ms hop). */
  fps?: number;
  /** Analysis window in ms. Default 40 — at least two periods down to 50 Hz. */
  windowMs?: number;
  /** Amplitude at or below this counts as silence. Default 0.01. */
  noiseFloor?: number;
  /** Autocorrelation peak below this counts as unvoiced. Default 0.3. */
  voicingThreshold?: number;
  /** Lowest F0 searched, Hz. Default 70. */
  minF0?: number;
  /** Highest F0 searched, Hz. Default 400. */
  maxF0?: number;
  /** Attach 16 kHz PCM to each frame. Default false. */
  withPcm?: boolean;
}

const DEFAULTS = {
  fps: 50,
  windowMs: 40,
  noiseFloor: 0.01,
  voicingThreshold: 0.3,
  minF0: 70,
  maxF0: 400,
};

/** Box-filtered decimation. Aliasing is acceptable here; F0 is not affected. */
export function decimate(samples: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return samples;
  const n = Math.floor(samples.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const base = i * factor;
    for (let j = 0; j < factor; j++) sum += samples[base + j];
    out[i] = sum / factor;
  }
  return out;
}

/**
 * Fundamental frequency of one window by normalized autocorrelation.
 * Returns 0 when the window is aperiodic or silent.
 */
export function estimateF0(
  win: Float32Array,
  sampleRate: number,
  minF0: number,
  maxF0: number,
  threshold: number,
): number {
  const minLag = Math.max(2, Math.floor(sampleRate / maxF0));
  const maxLag = Math.min(win.length - 2, Math.ceil(sampleRate / minF0));
  if (maxLag <= minLag) return 0;

  let energy = 0;
  for (let i = 0; i < win.length; i++) energy += win[i] * win[i];
  if (energy <= 1e-9) return 0;

  const span = maxLag - minLag + 1;
  const norms = new Float64Array(span);
  let best = 0;
  for (let k = 0; k < span; k++) {
    const lag = minLag + k;
    let sum = 0;
    const n = win.length - lag;
    for (let i = 0; i < n; i++) sum += win[i] * win[i + lag];
    const norm = (sum / n) / (energy / win.length);
    norms[k] = norm;
    if (norm > best) best = norm;
  }
  if (best < threshold) return 0;

  // Taking the global peak is wrong for harmonic signals: the lag at twice the
  // period correlates just as well, and half the frames would come out an
  // octave low. The first lag that reaches 90% of the peak is the fundamental.
  let pick = -1;
  for (let k = 0; k < span; k++) {
    if (norms[k] >= best * 0.9) {
      pick = k;
      break;
    }
  }
  if (pick < 0) return 0;

  // Parabolic interpolation around the chosen lag for sub-sample precision.
  const lag0 = minLag + pick;
  let refined = lag0;
  if (pick > 0 && pick < span - 1) {
    const a = norms[pick - 1];
    const b = norms[pick];
    const c = norms[pick + 1];
    const denom = a - 2 * b + c;
    if (Math.abs(denom) > 1e-12) refined = lag0 + (0.5 * (a - c)) / denom;
  }
  if (refined <= 0) return 0;
  return sampleRate / refined;
}

/**
 * Streaming framer. Push PCM in whatever chunk sizes the audio source gives
 * you; frames come out on a fixed grid tied to the stream start, never to the
 * chunk boundaries.
 */
export class Framer {
  private readonly sampleRate: number;
  private readonly fps: number;
  private readonly windowSamples: number;
  private readonly hopSamples: number;
  private readonly decFactor: number;
  private readonly noiseFloor: number;
  private readonly voicingThreshold: number;
  private readonly minF0: number;
  private readonly maxF0: number;
  private readonly withPcm: boolean;

  private buf: Float32Array;
  private filled = 0;
  /** Global sample index of buf[0]. */
  private origin = 0;
  private nextFrame = 0;

  constructor(sampleRate: number, opts: FrameOptions = {}) {
    if (!(sampleRate > 0)) throw new Error("Framer needs a positive sample rate, got " + sampleRate);
    this.sampleRate = sampleRate;
    this.fps = Math.max(1, Math.min(200, opts.fps ?? DEFAULTS.fps));
    this.windowSamples = Math.max(2, Math.round((sampleRate * (opts.windowMs ?? DEFAULTS.windowMs)) / 1000));
    this.hopSamples = Math.max(1, Math.round(sampleRate / this.fps));
    this.decFactor = Math.max(1, Math.floor(sampleRate / 6000));
    this.noiseFloor = opts.noiseFloor ?? DEFAULTS.noiseFloor;
    this.voicingThreshold = opts.voicingThreshold ?? DEFAULTS.voicingThreshold;
    this.minF0 = opts.minF0 ?? DEFAULTS.minF0;
    this.maxF0 = opts.maxF0 ?? DEFAULTS.maxF0;
    this.withPcm = opts.withPcm ?? false;
    this.buf = new Float32Array(Math.max(this.windowSamples * 4, 4096));
  }

  /** Append audio; returns every frame that became complete. */
  push(samples: Float32Array): AudioFrame[] {
    this.append(samples);
    return this.drain();
  }

  /** Nothing more is coming. Emits any frame the buffer can still complete. */
  flush(): AudioFrame[] {
    return this.drain();
  }

  private append(samples: Float32Array): void {
    const need = this.filled + samples.length;
    if (need > this.buf.length) {
      let cap = this.buf.length;
      while (cap < need) cap *= 2;
      const bigger = new Float32Array(cap);
      bigger.set(this.buf.subarray(0, this.filled));
      this.buf = bigger;
    }
    this.buf.set(samples, this.filled);
    this.filled += samples.length;
  }

  private drain(): AudioFrame[] {
    const out: AudioFrame[] = [];
    while (true) {
      const start = this.nextFrame * this.hopSamples;
      const offset = start - this.origin;
      if (offset + this.windowSamples > this.filled) break;
      out.push(this.frameAt(start, this.buf.subarray(offset, offset + this.windowSamples)));
      this.nextFrame++;
    }
    // Drop samples no future frame can need. Keep from the next frame's start so
    // memory does not grow with stream length.
    const keepFrom = this.nextFrame * this.hopSamples - this.origin;
    if (keepFrom > 0 && keepFrom >= this.buf.length / 2) {
      const remain = this.filled - keepFrom;
      this.buf.copyWithin(0, keepFrom, this.filled);
      this.filled = remain;
      this.origin += keepFrom;
    }
    return out;
  }

  private frameAt(startSample: number, win: Float32Array): AudioFrame {
    let sum = 0;
    for (let i = 0; i < win.length; i++) sum += win[i] * win[i];
    const rms = Math.sqrt(sum / win.length);

    let f0 = 0;
    if (rms > this.noiseFloor) {
      const ds = decimate(win, this.decFactor);
      f0 = estimateF0(ds, this.sampleRate / this.decFactor, this.minF0, this.maxF0, this.voicingThreshold);
    }

    const frame: AudioFrame = {
      at: Math.round((startSample * 1000) / this.sampleRate),
      rms: Math.round(rms * 10000) / 10000,
      f0: Math.round(f0 * 10) / 10,
      voiced: f0 > 0,
    };
    if (this.withPcm) frame.pcm = resample(win, this.sampleRate, 16000);
    return frame;
  }
}

/** Whole clip in, every frame out. Same framer the live path uses. */
export function framesFromWav(audio: WavAudio, opts: FrameOptions = {}): AudioFrame[] {
  const framer = new Framer(audio.sampleRate, opts);
  return [...framer.push(audio.samples), ...framer.flush()];
}
