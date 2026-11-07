/**
 * Renderer-side parameters, described as motion rather than as values.
 *
 * A cue arrives at an instant; a face does not move in an instant. Keeping the
 * gesture as a shape (start, peak, how long it takes to get there and come
 * back) means the engine never has to know what the renderer's frame rate is,
 * and a renderer never has to guess when to stop interpolating. It also means
 * every gesture is inspectable in a log, which a stream of mutating joint
 * values is not.
 *
 * Channels are names, not indices: "nod", "blink", "brow_raise". A renderer —
 * Live2D, VRM, a row of LEDs — maps them to whatever it has.
 */

export interface Gesture {
  /** What moves, e.g. "nod". */
  channel: string;
  /** Milliseconds from the start of the listening session. */
  at: number;
  /** 0..1, the maximum the channel reaches. */
  peak: number;
  riseMs: number;
  holdMs: number;
  fallMs: number;
}

/** How long the channel is off zero for. */
export function gestureDuration(g: Gesture): number {
  return Math.max(0, g.riseMs) + Math.max(0, g.holdMs) + Math.max(0, g.fallMs);
}

/**
 * Sample one gesture at time t, in 0..1.
 *
 * Linear on purpose. A smoothstep would look marginally nicer on a nod and
 * would make "did this gesture fire, and when" harder to read off a test —
 * the difference does not survive contact with a 60fps neck.
 */
export function gestureAt(g: Gesture, t: number): number {
  const peak = Math.max(0, Math.min(1, g.peak));
  if (peak === 0) return 0;
  const rise = Math.max(0, g.riseMs);
  const hold = Math.max(0, g.holdMs);
  const fall = Math.max(0, g.fallMs);
  const dt = t - g.at;
  if (dt < 0) return 0;
  if (dt < rise) return peak * (dt / rise);
  if (dt < rise + hold) return peak;
  const intoFall = dt - rise - hold;
  if (intoFall < fall) return peak * (1 - intoFall / fall);
  return 0;
}

/**
 * All active channels at time t.
 *
 * Overlapping gestures on one channel take the max, not the sum: two nods in
 * quick succession are still one neck, and a renderer that multiplies by 1.8
 * breaks the model's rig limits.
 */
export function gesturesAt(gestures: Gesture[], t: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of gestures) {
    const v = gestureAt(g, t);
    if (v <= 0) continue;
    const seen = out[g.channel];
    out[g.channel] = seen === undefined ? v : Math.max(seen, v);
  }
  return out;
}

/** Channels that are non-zero at any point in [from, to). Used by logs and tests. */
export function channelsBetween(gestures: Gesture[], from: number, to: number): string[] {
  const seen = new Set<string>();
  for (const g of gestures) {
    const start = g.at;
    const end = g.at + gestureDuration(g);
    if (end > from && start < to) seen.add(g.channel);
  }
  return [...seen];
}

/**
 * Gestures that begin inside a window. This is the one an acceptance check
 * wants: "did anything happen while they were still talking", not "was
 * something still fading out".
 */
export function gesturesStartingBetween(gestures: Gesture[], from: number, to: number): Gesture[] {
  return gestures.filter((g) => g.at >= from && g.at < to);
}
