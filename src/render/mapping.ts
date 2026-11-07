import type { Cue, CueType } from "../listen/cues.ts";
import type { Gesture } from "./gesture.ts";

/**
 * Cue -> gesture. The last hand-off before a renderer sees anything.
 *
 * Design notes, because the tempting alternatives are all worse:
 *
 * Confidence decides WHETHER, not HOW MUCH. A 0.55 nod and a 0.9 nod are both
 * nods; scaling the peak by confidence produces gestures too small to see and
 * makes the mapping impossible to test — you end up asserting on 0.33 instead
 * of on "a nod fired". So confidence becomes a gate at `minConfidence`, and the
 * peak comes from the character's mapping.
 *
 * Peak, not amplitude: every channel is 0..1 and the renderer owns the scale.
 * A Live2D model and a VRM skeleton have wildly different physical limits, and
 * a mapping that says "0.6" means "60% of whatever this rig allows".
 *
 * Gestures are per-channel and additive in time, not cumulative in value: two
 * overlapping nads resolve to the max, never the sum. A rig that gets 1.4 on a
 * neck parameter breaks.
 */

/** Every key a character's [mapping] block may set. Anything else is an error. */
export const MAPPING_KEYS = [
  "backchannel_nod",
  "backchannel_tilt",
  "hold_brow",
  "hold_gaze",
  "turn_take_blink",
  "turn_take_brow",
] as const;

export type MappingKey = (typeof MAPPING_KEYS)[number];

export interface RenderMapping {
  /** A nod during someone else's turn. 0 disables it. */
  backchannel_nod: number;
  /** A small head tilt with the nod, so the nod is not a vertical piston. */
  backchannel_tilt: number;
  /** Eyebrow lift while the speaker is mid-thought. "I am with you." */
  hold_brow: number;
  /** Gaze drift while waiting; keeps the face from being a statue. */
  hold_gaze: number;
  /** Blink on handover. Humans blink at turn boundaries far more than chance. */
  turn_take_blink: boolean;
  /** Eyebrow lift on handover — the "go on" face. */
  turn_take_brow: number;
}

export const DEFAULT_MAPPING: RenderMapping = {
  backchannel_nod: 0.5,
  backchannel_tilt: 0.25,
  hold_brow: 0.3,
  hold_gaze: 0.4,
  turn_take_blink: true,
  turn_take_brow: 0.5,
};

export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MappingError";
  }
}

/** Cues quieter than this produce nothing at all. */
export const MIN_CONFIDENCE = 0.3;

interface Shape {
  riseMs: number;
  holdMs: number;
  fallMs: number;
}

// Physical gestures take time. These are deliberately human-scale: a nod that
// completes in 40ms reads as a twitch, and one that takes 900ms reads as a bow.
const NOD: Shape = { riseMs: 120, holdMs: 90, fallMs: 200 };
const TILT: Shape = { riseMs: 160, holdMs: 120, fallMs: 260 };
const BROW: Shape = { riseMs: 90, holdMs: 160, fallMs: 220 };
const GAZE: Shape = { riseMs: 220, holdMs: 320, fallMs: 260 };
const BLINK: Shape = { riseMs: 50, holdMs: 60, fallMs: 90 };
const GO_ON: Shape = { riseMs: 100, holdMs: 200, fallMs: 260 };

/**
 * Read and validate a character's [mapping] table.
 *
 * Unknown keys throw rather than being ignored. A typo that silently does
 * nothing is the worst kind: the character looks broken and the config looks
 * fine, and there is no way to tell which one is lying.
 */
export function readMapping(raw: Record<string, unknown> = {}): RenderMapping {
  const out: RenderMapping = { ...DEFAULT_MAPPING };
  const known = new Set<string>(MAPPING_KEYS);

  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) {
      throw new MappingError("unknown mapping key: " + key + " (expected one of " + MAPPING_KEYS.join(", ") + ")");
    }
    if (key === "turn_take_blink") {
      if (typeof value !== "boolean") {
        throw new MappingError("[mapping] turn_take_blink must be true or false, got " + JSON.stringify(value));
      }
      out.turn_take_blink = value;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new MappingError("[mapping] " + key + " must be a number, got " + JSON.stringify(value));
    }
    // 0 is legal and means "off": a character with a stiff neck is a valid
    // character, and disabling a channel is the only way to express that.
    if (value < 0 || value > 1) {
      throw new MappingError("[mapping] " + key + " must be between 0 and 1, got " + value);
    }
    out[key as Exclude<MappingKey, "turn_take_blink">] = value;
  }

  return out;
}

function add(out: Gesture[], channel: string, at: number, peak: number, shape: Shape): void {
  if (!(peak > 0)) return;
  out.push({ channel, at, peak, riseMs: shape.riseMs, holdMs: shape.holdMs, fallMs: shape.fallMs });
}

function gesturesFor(cue: Cue, mapping: RenderMapping): Gesture[] {
  if (cue.confidence < MIN_CONFIDENCE) return [];
  const out: Gesture[] = [];
  const kind: CueType = cue.type;

  if (kind === "backchannel") {
    add(out, "nod", cue.at, mapping.backchannel_nod, NOD);
    add(out, "head_tilt", cue.at, mapping.backchannel_tilt, TILT);
  } else if (kind === "hold") {
    // A hold is the quietest reaction on purpose. If the pause is 220ms and the
    // character throws a big gesture at it, the pause becomes about the
    // character instead of about the speaker.
    add(out, "brow_raise", cue.at, mapping.hold_brow, BROW);
    add(out, "gaze_shift", cue.at, mapping.hold_gaze, GAZE);
  } else if (kind === "turn_take") {
    add(out, "brow_raise", cue.at, mapping.turn_take_brow, GO_ON);
    if (mapping.turn_take_blink) add(out, "blink", cue.at, 1, BLINK);
  }
  // "idle" is not a gesture. Nothing happening is a valid state of a face, and
  // inventing motion so that the screen is never still is how characters start
  // to look like screensavers.

  return out;
}

/**
 * Map every cue to its gestures. Order follows the cues, and within a cue the
 * channels come out in a fixed order so that a log is stable between runs.
 */
export function mapCues(cues: Cue[], mapping: RenderMapping = DEFAULT_MAPPING): Gesture[] {
  const out: Gesture[] = [];
  for (const cue of cues) out.push(...gesturesFor(cue, mapping));
  return out;
}
