/**
 * Channels -> Cubism parameters.
 *
 * The mapping is deliberately short. A Live2D model has hundreds of parameters
 * and most of them are props: hair layers, a phone, a whale that swims past the
 * window. Driving any of those from a conversation would be inventing behaviour
 * the model was never designed to express, so this backend touches six things:
 * head angle, eye ball, brows, eye openness, mouth openness. Everything else is
 * left to the model author's idle motion, which is a better animator than a
 * list of numbers.
 *
 * Signs, stated once so they are not folklore:
 *
 *   nod        -> ParamAngleY negative (Cubism: +Y is chin up)
 *   head_tilt  -> ParamAngleZ negative (Cubism: +Z leans toward the model's left)
 *   gaze_shift -> ParamEyeBallX positive. The cue carries no direction - the
 *                 listening layer decides *that* the character glances, not
 *                 which way - so the direction is fixed here, and this comment
 *                 is where to change it when the cue grows one.
 *                 ParamEyeBallY is used for a small upward component so the
 *                 glance does not read as "looking at the floor".
 *   brow_raise -> ParamBrowLY / ParamBrowRY positive
 *   blink      -> ParamEyeLOpen / ParamEyeROpen open-ness (1 - blink)
 *   mouth      -> ParamMouthOpenY, straight from the envelope
 *
 * When the model declares its parameters (DisplayInfo present) anything missing
 * is dropped with a reason. When it does not, the standard names are assumed and
 * the frame says so - assuming silently and assuming loudly are different
 * failures, and only one of them is debuggable.
 */

import type { PoseFrame, RenderInput, RendererBackend } from "../backend.ts";
import { channelsAt } from "../backend.ts";
import { lipSyncParameters, type Live2DRig } from "./model3.ts";

/** Peak channel value -> Cubism units. Cubism angles are degrees, roughly +-30. */
const NOD_DEGREES = 12;
const TILT_DEGREES = 9;
const GAZE_X = 0.8;
const GAZE_Y_ELEVATION = 0.25;
const BROW = 0.8;

export interface Live2DBackendOptions {
  nodDegrees?: number;
  tiltDegrees?: number;
  gazeX?: number;
  brow?: number;
}

export class Live2DBackend implements RendererBackend {
  readonly id = "live2d";
  readonly rig: Live2DRig;
  private readonly nodDegrees: number;
  private readonly tiltDegrees: number;
  private readonly gazeX: number;
  private readonly brow: number;
  private readonly lipSync: string[];
  private readonly unsupported: Record<string, string>;

  constructor(rig: Live2DRig, options: Live2DBackendOptions = {}) {
    this.rig = rig;
    this.nodDegrees = options.nodDegrees ?? NOD_DEGREES;
    this.tiltDegrees = options.tiltDegrees ?? TILT_DEGREES;
    this.gazeX = options.gazeX ?? GAZE_X;
    this.brow = options.brow ?? BROW;
    this.lipSync = lipSyncParameters(rig);
    this.unsupported = this.findUnsupported();
  }

  /** Channels this model cannot express, and why. Empty when nothing is known. */
  get unsupportedChannels(): Record<string, string> {
    return this.unsupported;
  }

  frame(input: RenderInput): PoseFrame {
    const channels = channelsAt(input.gestures, input.at);
    const parameters: Record<string, number> = {};
    const dropped: string[] = [];

    const nod = channels.nod ?? 0;
    const tilt = channels.head_tilt ?? 0;
    const gaze = channels.gaze_shift ?? 0;
    const brow = channels.brow_raise ?? 0;
    const blink = channels.blink ?? 0;
    const mouth = clamp01(input.mouth ?? 0);

    // Head: one parameter each, no composition needed - Cubism angles are
    // already three independent axes, unlike a bone rotation. Only written when
    // the channel is live: a frame that writes 0 every time pins the head and
    // cancels whatever idle head motion the model ships with. Same reasoning as
    // blink below, and the same mistake if it is skipped.
    if (nod > 0) this.set(parameters, dropped, "ParamAngleY", -nod * this.nodDegrees, "nod");
    if (tilt > 0) this.set(parameters, dropped, "ParamAngleZ", -tilt * this.tiltDegrees, "head_tilt");

    if (gaze > 0) {
      this.set(parameters, dropped, "ParamEyeBallX", gaze * this.gazeX, "gaze_shift");
      this.set(parameters, dropped, "ParamEyeBallY", gaze * GAZE_Y_ELEVATION, "gaze_shift");
    }

    if (brow > 0) {
      this.set(parameters, dropped, "ParamBrowLY", brow * this.brow, "brow_raise");
      this.set(parameters, dropped, "ParamBrowRY", brow * this.brow, "brow_raise");
    }

    // Blink is the inverse of eye openness. Writing 0 when no blink is live
    // would also cancel the model's own blink motion, so idle frames leave the
    // parameter alone rather than pinning the eyes open.
    if (blink > 0) {
      const openness = 1 - clamp01(blink);
      const ids = this.rig.eyeBlinkIds.length ? this.rig.eyeBlinkIds : ["ParamEyeLOpen", "ParamEyeROpen"];
      for (const id of ids) this.set(parameters, dropped, id, openness, "blink");
    }

    if (mouth > 0) {
      for (const id of this.lipSync) this.set(parameters, dropped, id, mouth, "mouth");
    }

    return {
      at: input.at,
      state: input.state,
      channels,
      parameters,
      bones: {},
      expressions: {},
      dropped: [...new Set(dropped)],
      parametersAssumed: !this.rig.parametersKnown,
    };
  }

  /**
   * Write one parameter, or record why it could not be written.
   *
   * A model with a DisplayInfo list is checked strictly: a missing id is a fact.
   * A model without one cannot be checked at all, so the value is written and
   * the frame carries assumedParameters = true instead of a claim.
   */
  private set(
    into: Record<string, number>,
    dropped: string[],
    id: string,
    value: number,
    channel: string,
  ): void {
    if (!Number.isFinite(value)) return;
    if (this.rig.parametersKnown && !this.rig.parameters.has(id)) {
      dropped.push(channel + ": model has no parameter " + id);
      return;
    }
    into[id] = value;
  }

  private findUnsupported(): Record<string, string> {
    if (!this.rig.parametersKnown) return {};
    const missing = (ids: string[]): string[] => ids.filter((id) => !this.rig.parameters.has(id));
    const out: Record<string, string> = {};
    for (const id of missing(["ParamAngleY"])) out.nod = "no " + id;
    for (const id of missing(["ParamAngleZ"])) out.head_tilt = "no " + id;
    for (const id of missing(["ParamEyeBallX"])) out.gaze_shift = "no " + id;
    for (const id of missing(["ParamBrowLY", "ParamBrowRY"])) out.brow_raise = "no " + id;
    const blinkIds = this.rig.eyeBlinkIds.length ? this.rig.eyeBlinkIds : ["ParamEyeLOpen", "ParamEyeROpen"];
    for (const id of missing(blinkIds)) out.blink = "no " + id;
    for (const id of missing(this.lipSync)) out.mouth = "no " + id;
    return out;
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
