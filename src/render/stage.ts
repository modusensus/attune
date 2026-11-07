/**
 * The clock between events and pictures.
 *
 * A RendererBackend is a pure function of state, gestures, mouth and t. This is
 * the thing that owns t: it remembers the gestures that have happened and the
 * mouth curve that came out of the last reply, and answers "what should the
 * picture look like now".
 *
 * It lives outside the engine on purpose. The engine finishes a turn and then
 * exists only as memory; a renderer keeps drawing sixty times a second while
 * nobody is talking. The two must not share a clock, or the idle character
 * freezes the moment the reply is over.
 */

import type { EngineState } from "../types.ts";
import type { MouthFrame } from "../audio/envelope.ts";
import type { PoseFrame, RendererBackend } from "./backend.ts";
import type { Gesture } from "./gesture.ts";

export class Stage {
  readonly backend: RendererBackend;
  private state: EngineState;
  private gestures: Gesture[];
  private mouth: MouthFrame[];

  constructor(backend: RendererBackend, state: EngineState = "listening") {
    this.backend = backend;
    this.state = state;
    this.gestures = [];
    this.mouth = [];
  }

  get currentState(): EngineState {
    return this.state;
  }

  get gestureCount(): number {
    return this.gestures.length;
  }

  setState(state: EngineState): void {
    this.state = state;
  }

  /** Append reactions. Order does not matter; sampling is per gesture. */
  addGestures(gestures: Gesture[]): void {
    for (const g of gestures) this.gestures.push(g);
  }

  /**
   * Replace the mouth curve. The newest reply wins: keeping an older curve
   * around would open the mouth for words that ended ten seconds ago.
   */
  setMouth(frames: MouthFrame[]): void {
    this.mouth = frames.slice().sort((a, b) => a.at - b.at);
  }

  /**
   * Mouth opening at t, in 0..1.
   *
   * Zero before the curve starts, linear between frames, and whatever the last
   * frame said afterwards - the envelope forces its last frame closed, so
   * "afterwards" is closed without this file having to assume it.
   */
  mouthAt(t: number): number {
    const frames = this.mouth;
    if (!frames.length) return 0;
    if (t < frames[0].at) return 0;
    const last = frames[frames.length - 1];
    if (t >= last.at) return clamp01(last.open);
    let lo = 0;
    let hi = frames.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].at <= t) lo = mid;
      else hi = mid;
    }
    const a = frames[lo];
    const b = frames[hi];
    const span = b.at - a.at;
    const k = span > 0 ? (t - a.at) / span : 0;
    return clamp01(a.open + (b.open - a.open) * k);
  }

  frameAt(t: number): PoseFrame {
    return this.backend.frame({
      state: this.state,
      at: t,
      gestures: this.gestures,
      mouth: this.mouthAt(t),
    });
  }

  /** Forget a finished turn's reactions so they are not replayed. */
  clearGestures(): void {
    this.gestures = [];
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
