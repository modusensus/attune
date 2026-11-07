/**
 * Channels -> a VRM skeleton.
 *
 * The rules of this file are all consequences of one fact: a VRM node's rest
 * rotation is whatever the exporter felt like, and a VRM 1.0 head very often
 * sits at a half turn in its own local space. Adding twelve degrees to a local
 * axis on a bone like that tilts the head sideways and calls it a nod. So every
 * rotation here is composed in world space and only then pushed back down into
 * the bone's local space:
 *
 *     localNew = parentWorld^-1 * worldDelta * parentWorld * localRest
 *
 * which is the same statement as "rotate the bone by worldDelta, measured in
 * the world, not in whatever frame the bone was born in".
 *
 * Nothing here invents motion. If the model has no eyebrow expression, the brow
 * channel is dropped and says so. A face that moves for no reason reads as a
 * screensaver, and a log that claims a brow moved when it did not is worse than
 * either.
 */

import { channelsAt, type PoseFrame, type RenderInput, type RendererBackend } from "../backend.ts";
import {
  axisVector,
  conjugate,
  fromAxisAngle,
  multiply,
  rotate,
  type Quat,
  type Vec3,
} from "./quat.ts";
import type { VrmRig } from "./vrm.ts";

/** Peak channel value -> degrees of head motion. */
const NOD_DEGREES = 12;
const TILT_DEGREES = 9;
const GAZE_DEGREES = 7;
const JAW_DEGREES = 9;

/**
 * Expressions a brow lift may live in. Models name it whatever they like, so
 * this is a preference list, not a schema.
 *
 * "surprised" is deliberately absent even though it lifts the brows: it also
 * widens the eyes and often opens the mouth, so at the 0.3 a listening hold
 * asks for it reads as a character that is startled every four seconds. A
 * model without a real brow expression gets an honest drop instead.
 */
const BROW_CANDIDATES = ["browInnerUp", "browUp", "browsUp", "browOuterUp", "eyebrowUp"];

export interface VrmBackendOptions {
  /** Degrees per unit of the nod channel. Lower for a model with a stiff neck. */
  nodDegrees?: number;
  tiltDegrees?: number;
  gazeDegrees?: number;
  jawDegrees?: number;
  /**
   * Apply the mouth curve to the jaw bone as well as the aa expression. On by
   * default when the model has a jaw; a model without one just skips it.
   */
  jawFromMouth?: boolean;
}

export class VrmBackend implements RendererBackend {
  readonly id = "vrm";
  readonly rig: VrmRig;
  private readonly nodDegrees: number;
  private readonly tiltDegrees: number;
  private readonly gazeDegrees: number;
  private readonly jawDegrees: number;
  private readonly jawFromMouth: boolean;
  /** Channels this rig structurally cannot express, worked out once. */
  private readonly unsupported: Map<string, string>;

  constructor(rig: VrmRig, options: VrmBackendOptions = {}) {
    this.rig = rig;
    this.nodDegrees = options.nodDegrees ?? NOD_DEGREES;
    this.tiltDegrees = options.tiltDegrees ?? TILT_DEGREES;
    this.gazeDegrees = options.gazeDegrees ?? GAZE_DEGREES;
    this.jawDegrees = options.jawDegrees ?? JAW_DEGREES;
    this.jawFromMouth = options.jawFromMouth ?? true;
    this.unsupported = this.findUnsupported();
  }

  /** Every channel this rig cannot express, and why. For the report. */
  get unsupportedChannels(): Record<string, string> {
    return Object.fromEntries(this.unsupported);
  }

  frame(input: RenderInput): PoseFrame {
    const channels = channelsAt(input.gestures, input.at);
    const bones: PoseFrame["bones"] = {};
    const expressions: Record<string, number> = {};
    const dropped: string[] = [];

    const nod = channels.nod ?? 0;
    const tilt = channels.head_tilt ?? 0;
    const gaze = channels.gaze_shift ?? 0;
    const brow = channels.brow_raise ?? 0;
    const blink = channels.blink ?? 0;

    // Head: nod about world X, tilt about world Z. Both can be live at once, so
    // they compose into one delta instead of fighting over the bone.
    const head = this.rig.bones.head;
    const headDelta = combine([
      { axis: axisVector("x"), radians: deg(nod * this.nodDegrees) },
      { axis: axisVector("z"), radians: deg(tilt * this.tiltDegrees) },
    ]);
    if (head !== undefined && !isNoop(headDelta)) {
      bones["head"] = this.applyWorldDelta(head, headDelta);
    } else if (head === undefined && (nod > 0 || tilt > 0)) {
      dropped.push("nod/head_tilt: model has no head bone");
    }

    // Gaze moves the eyes when it can and says so when it cannot. Rotating the
    // head to fake an eye movement is a bigger, wronger motion.
    if (gaze > 0) {
      const delta = fromAxisAngle(axisVector("y"), deg(gaze * this.gazeDegrees));
      const left = this.rig.bones.leftEye;
      const right = this.rig.bones.rightEye;
      if (left !== undefined) bones["leftEye"] = this.applyWorldDelta(left, delta);
      if (right !== undefined) bones["rightEye"] = this.applyWorldDelta(right, delta);
      if (left === undefined && right === undefined) {
        dropped.push("gaze_shift: model has no eye bones (gaze is bone-driven in VRM 1.0)");
      }
    }

    // Mouth: the envelope is already a 0..1 curve, so the aa weight is the
    // curve. This is not lip sync - it is a jaw that opens when sound comes out,
    // which is what an envelope can honestly claim.
    const mouth = clamp01(input.mouth ?? 0);
    if (mouth > 0) {
      if (this.canExpress("aa")) expressions.aa = mouth;
      else dropped.push("mouth: model has no aa expression");

      if (this.jawFromMouth) {
        const jaw = this.rig.bones.jaw;
        if (jaw !== undefined) {
          bones["jaw"] = this.applyWorldDelta(jaw, fromAxisAngle(axisVector("x"), deg(mouth * this.jawDegrees)));
        }
      }
    }

    // Brow: whichever expression the model happens to call it.
    if (brow > 0) {
      const name = this.pickBrowExpression();
      if (name) expressions[name] = brow;
      else dropped.push("brow_raise: model has no eyebrow expression (VRM defines none, and this one ships no custom brow)");
    }

    if (blink > 0) {
      if (this.canExpress("blink")) expressions.blink = blink;
      else dropped.push("blink: model has no blink expression");
    }

    return {
      at: input.at,
      state: input.state,
      channels,
      bones,
      expressions,
      dropped: dedupe(dropped),
    };
  }

  /**
   * Rest local rotation, rotated by a delta expressed in world space.
   *
   * The parent's world rotation cancels the frame the bone lives in, the delta
   * happens in the world, and the parent frame is put back. Applying the delta
   * straight to the local rotation would rotate about the bone's local axes,
   * which is only the same thing for bones that happen to be axis-aligned.
   */
  private applyWorldDelta(nodeIndex: number, worldDelta: Quat): { x: number; y: number; z: number; w: number } {
    const node = this.rig.nodes[nodeIndex];
    const parentWorld = this.parentWorld(nodeIndex);
    const localNew = multiply(
      multiply(conjugate(parentWorld), worldDelta),
      multiply(parentWorld, node.rotation),
    );
    return { x: localNew.x, y: localNew.y, z: localNew.z, w: localNew.w };
  }

  private parentWorld(nodeIndex: number): Quat {
    const parent = this.rig.nodes[nodeIndex].parent;
    if (parent === null) return { x: 0, y: 0, z: 0, w: 1 };
    return this.rig.restWorld[parent] ?? { x: 0, y: 0, z: 0, w: 1 };
  }

  private canExpress(name: string): boolean {
    const e = this.rig.expressions[name];
    return !!e && e.bound;
  }

  private pickBrowExpression(): string | null {
    for (const candidate of BROW_CANDIDATES) {
      if (this.canExpress(candidate)) return candidate;
    }
    // Case-insensitive fallback: exporters differ on capitalisation.
    for (const [name, expression] of Object.entries(this.rig.expressions)) {
      if (!expression.bound) continue;
      if (/brow|eyebrow/i.test(name)) return name;
    }
    return null;
  }

  private findUnsupported(): Map<string, string> {
    const out = new Map<string, string>();
    if (this.rig.bones.head === undefined) out.set("nod", "no head bone");
    if (this.rig.bones.head === undefined) out.set("head_tilt", "no head bone");
    if (this.rig.bones.leftEye === undefined && this.rig.bones.rightEye === undefined) {
      out.set("gaze_shift", "no eye bones");
    }
    if (!this.pickBrowExpression()) out.set("brow_raise", "no eyebrow expression");
    if (!this.canExpress("blink")) out.set("blink", "no blink expression");
    if (!this.canExpress("aa")) out.set("mouth", "no aa expression");
    return out;
  }
}

function deg(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function isNoop(q: Quat): boolean {
  return Math.hypot(q.x, q.y, q.z) < 1e-9;
}

/** Compose several axis rotations into one delta, in the order given. */
function combine(parts: { axis: Vec3; radians: number }[]): Quat {
  let out: Quat = { x: 0, y: 0, z: 0, w: 1 };
  for (const part of parts) {
    if (part.radians === 0) continue;
    out = multiply(out, fromAxisAngle(part.axis, part.radians));
  }
  return out;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Exported for tests: the world-space rotation a single axis delta produces. */
export function rotateByAxis(v: Vec3, axis: Vec3, radians: number): Vec3 {
  return rotate(fromAxisAngle(axis, radians), v);
}