/**
 * The seam between "what the character is doing" and "what the picture does".
 *
 * Everything above this line deals in channels and cues: nod, blink, brow_raise,
 * a mouth opening from 0 to 1. Everything below it is a specific rig. A Live2D
 * model has parameters called ParamAngleZ; a VRM model has a neck bone and a
 * blend shape list; neither of them should have to appear in the engine, and
 * neither should be able to change what the listening layer decides.
 *
 * A backend is a pure function of its input. It holds no clock, owns no canvas,
 * and returns what a frame should look like rather than applying it. That is
 * what makes it testable without a GPU, and it is why mount/apply/drive from
 * docs/ARCHITECTURE.md collapse into one call here: in a headless engine the
 * clock belongs to whoever is drawing, not to the thing computing poses.
 */

import type { EngineState } from "../types.ts";
import type { Gesture } from "./gesture.ts";

export interface RenderInput {
  state: EngineState;
  /** Milliseconds since the session started. The caller owns this clock. */
  at: number;
  /**
   * Every gesture this session has produced, not just the live ones. Sampling
   * is cheap and the backend is stateless; filtering upstream would just move
   * the same loop somewhere less visible.
   */
  gestures: Gesture[];
  /** Current mouth opening, 0..1, from the audio envelope. */
  mouth?: number;
}

export interface PoseFrame {
  at: number;
  state: EngineState;
  /** Channel values at this instant, before any rig-specific interpretation. */
  channels: Record<string, number>;
  /** Canonical humanoid bone name -> local rest rotation composed with the delta. */
  bones: Record<string, { x: number; y: number; z: number; w: number }>;
  /** Expression name -> weight, 0..1. Already filtered to what the model has. */
  expressions: Record<string, number>;
  /**
   * Channels this rig could not express, with the reason. Reported rather than
   * silently swallowed: "the eyebrows never move" should be visible in a log,
   * not discovered after a week of wondering why the character looks blank.
   */
  dropped: string[];
}

export interface RendererBackend {
  readonly id: string;
  frame(input: RenderInput): PoseFrame;
}

export class RendererError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RendererError";
  }
}

/**
 * No rig at all. Channels pass through untouched, which is the honest output
 * when there is no picture: a caller can print them, log them, or drive a row
 * of LEDs with them.
 */
export class NullBackend implements RendererBackend {
  readonly id = "none";

  frame(input: RenderInput): PoseFrame {
    return {
      at: input.at,
      state: input.state,
      channels: channelsAt(input.gestures, input.at),
      bones: {},
      expressions: {},
      dropped: [],
    };
  }
}

export function channelsAt(gestures: Gesture[], t: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of gestures) {
    const peak = Math.max(0, Math.min(1, g.peak));
    if (peak === 0) continue;
    const dt = t - g.at;
    if (dt < 0) continue;
    const rise = Math.max(0, g.riseMs);
    const hold = Math.max(0, g.holdMs);
    const fall = Math.max(0, g.fallMs);
    let v: number;
    if (dt < rise) v = peak * (dt / rise);
    else if (dt < rise + hold) v = peak;
    else if (dt < rise + hold + fall) v = peak * (1 - (dt - rise - hold) / fall);
    else continue;
    if (v <= 0) continue;
    const seen = out[g.channel];
    out[g.channel] = seen === undefined ? v : Math.max(seen, v);
  }
  return out;
}
