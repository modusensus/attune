import assert from "node:assert/strict";
import { test } from "node:test";
import { VrmBackend } from "../src/render/vrm/backend.ts";
import { parseVrm, type VrmRig } from "../src/render/vrm/vrm.ts";
import { angleOf, conjugate, fromAxisAngle, axisVector, multiply, type Quat } from "../src/render/vrm/quat.ts";
import { buildGlb, vrm10, vrm0 } from "./fixtures/vrm-build.ts";

const rig = (options = {}) => parseVrm(buildGlb({ json: vrm10(options) }), "sample");

const instant = (channel: string, peak = 1) => ({ channel, at: 0, peak, riseMs: 0, holdMs: 0, fallMs: 0 });
const held = (channel: string, peak = 1) => ({ channel, at: 0, peak, riseMs: 0, holdMs: 100, fallMs: 0 });

/** The world rotation a bone ends up with, given its parent chain. */
function worldOf(rig: VrmRig, bone: string, local: { x: number; y: number; z: number; w: number }): Quat {
  const node = rig.nodes[rig.bones[bone]];
  const parent = node.parent === null ? null : rig.restWorld[node.parent];
  return parent ? multiply(parent, local) : local;
}

/** The world-space rotation that was added on top of rest. */
function deltaOf(rig: VrmRig, bone: string, local: { x: number; y: number; z: number; w: number }): Quat {
  return multiply(worldOf(rig, bone, local), conjugate(rig.restWorld[rig.bones[bone]]));
}

const degrees = (q: Quat) => (angleOf(q) * 180) / Math.PI;

test("a nod turns the head about the world X axis, twelve degrees", () => {
  const r = rig();
  const frame = new VrmBackend(r).frame({ state: "listening", at: 0, gestures: [held("nod")] });
  const delta = deltaOf(r, "head", frame.bones.head);
  assert.ok(Math.abs(degrees(delta) - 12) < 1e-6, "twelve degrees, no more and no less");
  const imaginary = Math.hypot(delta.x, delta.y, delta.z);
  assert.ok(Math.abs(Math.abs(delta.x) / imaginary - 1) < 1e-6, "the axis is X");
});

test("a nod stays about world X even when the head rests at a half turn", () => {
  // This is the whole reason applyWorldDelta exists. A VRM 1.0 head very often
  // sits at 180 degrees in its own local space; adding twelve degrees to the
  // local X axis on a bone like that rotates about the world -X and, worse,
  // reads as a head that tips sideways rather than down.
  const r = rig({ headRotation: [0, 1, 0, 0] });
  assert.ok(Math.abs(degrees(r.restWorld[r.bones.head]) - 180) < 1e-6, "the fixture really is a half turn");
  const frame = new VrmBackend(r).frame({ state: "listening", at: 0, gestures: [held("nod")] });
  const delta = deltaOf(r, "head", frame.bones.head);
  assert.ok(Math.abs(degrees(delta) - 12) < 1e-6, "still twelve degrees in the world");
  const imaginary = Math.hypot(delta.x, delta.y, delta.z);
  assert.ok(Math.abs(Math.abs(delta.x) / imaginary - 1) < 1e-6, "still about world X");
  const sideLeak = Math.abs(delta.z) / imaginary;
  assert.ok(sideLeak < 1e-6, "no sideways leak");
});

test("a tilted parent frame does not twist the nod", () => {
  // Parent rotations must cancel out, or a character standing on a slope would
  // nod in a different direction from one standing flat.
  const quarter = fromAxisAngle(axisVector("z"), Math.PI / 2);
  const r = rig({ hipsRotation: [quarter.x, quarter.y, quarter.z, quarter.w] });
  const frame = new VrmBackend(r).frame({ state: "listening", at: 0, gestures: [held("nod")] });
  const delta = deltaOf(r, "head", frame.bones.head);
  assert.ok(Math.abs(degrees(delta) - 12) < 1e-6);
  const imaginary = Math.hypot(delta.x, delta.y, delta.z);
  assert.ok(Math.abs(Math.abs(delta.x) / imaginary - 1) < 1e-6, "the world axis is still X, not the tilted local one");
});

test("head_tilt turns about world Z and the two head channels compose", () => {
  const r = rig();
  const backend = new VrmBackend(r);
  const tiltOnly = backend.frame({ state: "listening", at: 0, gestures: [held("head_tilt")] });
  const tiltDelta = deltaOf(r, "head", tiltOnly.bones.head);
  const tiltImag = Math.hypot(tiltDelta.x, tiltDelta.y, tiltDelta.z);
  assert.ok(Math.abs(degrees(tiltDelta) - 9) < 1e-6, "nine degrees of tilt");
  assert.ok(Math.abs(Math.abs(tiltDelta.z) / tiltImag - 1) < 1e-6, "about Z");

  const both = backend.frame({ state: "listening", at: 0, gestures: [held("nod"), held("head_tilt")] });
  const bothDelta = deltaOf(r, "head", both.bones.head);
  const bothImag = Math.hypot(bothDelta.x, bothDelta.y, bothDelta.z);
  assert.ok(bothImag > 0, "the head still moved");
  assert.ok(Math.abs(bothDelta.x) / bothImag > 0.4, "the nod is present");
  assert.ok(Math.abs(bothDelta.z) / bothImag > 0.3, "the tilt is present");
  assert.ok(degrees(bothDelta) > 12, "two rotations compose into more than either alone");
});

test("the head does not move at all when nothing is asked of it", () => {
  const r = rig();
  const frame = new VrmBackend(r).frame({ state: "listening", at: 0, gestures: [] });
  assert.deepEqual(frame.bones, {}, "an idle face is a valid face");
  assert.deepEqual(frame.expressions, {});
  assert.deepEqual(frame.dropped, []);
});

test("gaze moves the eyes and leaves the head alone", () => {
  const r = rig({ eyes: true });
  const frame = new VrmBackend(r).frame({ state: "listening", at: 0, gestures: [held("gaze_shift")] });
  assert.equal(frame.bones.head, undefined, "looking is not turning");
  assert.ok(frame.bones.leftEye);
  assert.ok(frame.bones.rightEye);
  for (const eye of ["leftEye", "rightEye"]) {
    const delta = deltaOf(r, eye, frame.bones[eye]);
    assert.ok(Math.abs(degrees(delta) - 7) < 1e-6);
    const imag = Math.hypot(delta.x, delta.y, delta.z);
    assert.ok(Math.abs(Math.abs(delta.y) / imag - 1) < 1e-6, "about Y, which is yaw");
  }
});

test("gaze without eye bones is dropped with a reason", () => {
  const r = rig();
  const backend = new VrmBackend(r);
  const frame = backend.frame({ state: "listening", at: 0, gestures: [held("gaze_shift")] });
  assert.deepEqual(frame.bones, {}, "no invented head turn to fake it");
  assert.equal(frame.dropped.length, 1);
  assert.match(frame.dropped[0], /gaze_shift: model has no eye bones/);
  assert.equal(backend.unsupportedChannels.gaze_shift, "no eye bones");
});

test("the mouth opens the aa morph and the jaw together", () => {
  const r = rig({ jaw: true });
  const frame = new VrmBackend(r).frame({ state: "speaking", at: 0, gestures: [], mouth: 0.6 });
  assert.equal(frame.expressions.aa, 0.6);
  assert.ok(frame.bones.jaw, "the jaw bone moves too");
  const delta = deltaOf(r, "jaw", frame.bones.jaw);
  const expected = 0.6 * 9;
  assert.ok(Math.abs(degrees(delta) - expected) < 1e-6, "jaw degrees scale with the envelope");
});

test("a model without a jaw still opens its mouth, and one without aa says so", () => {
  const noJaw = rig();
  const withAa = new VrmBackend(noJaw).frame({ state: "speaking", at: 0, gestures: [], mouth: 0.5 });
  assert.equal(withAa.expressions.aa, 0.5, "the morph is enough on its own");

  const json = vrm10() as Record<string, unknown>;
  const ext = json.extensions as Record<string, Record<string, Record<string, unknown>>>;
  delete ext.VRMC_vrm.expressions.preset.aa;
  const r = parseVrm(buildGlb({ json }), "sample");
  const frame = new VrmBackend(r).frame({ state: "speaking", at: 0, gestures: [], mouth: 0.5 });
  assert.equal(frame.expressions.aa, undefined);
  assert.ok(frame.dropped.some((d) => /mouth: model has no aa expression/.test(d)));
});

test("the mouth value is clamped and NaN-safe", () => {
  const r = rig({ jaw: true });
  const backend = new VrmBackend(r);
  assert.equal(backend.frame({ state: "speaking", at: 0, gestures: [], mouth: 5 }).expressions.aa, 1);
  assert.equal(backend.frame({ state: "speaking", at: 0, gestures: [], mouth: -2 }).expressions.aa, undefined);
  const nan = backend.frame({ state: "speaking", at: 0, gestures: [], mouth: Number.NaN });
  assert.deepEqual(nan.expressions, {}, "a NaN envelope must not poison the morph weights");
});

test("a brow lift is dropped honestly when the model has no brow expression", () => {
  // VRM defines no eyebrow preset, and the two real sample models this was
  // tested against both ship no custom one. The alternative - nudging the head
  // so something happens - is how a character starts looking like a screensaver.
  const r = rig();
  const backend = new VrmBackend(r);
  const frame = backend.frame({ state: "listening", at: 0, gestures: [held("brow_raise")] });
  assert.deepEqual(frame.expressions, {});
  assert.deepEqual(frame.bones, {}, "nothing else moved in its place");
  assert.ok(frame.dropped.some((d) => /brow_raise: model has no eyebrow expression/.test(d)));
  assert.equal(backend.unsupportedChannels.brow_raise, "no eyebrow expression");
});

test("a model that does have a brow expression uses it", () => {
  const r = rig({ customExpressions: ["browInnerUp"] });
  const frame = new VrmBackend(r).frame({ state: "listening", at: 0, gestures: [held("brow_raise", 0.8)] });
  assert.equal(frame.expressions.browInnerUp, 0.8);
});

test("surprise is never used as a stand-in for a brow lift", () => {
  // It lifts the brows, but it also widens the eyes and often opens the mouth.
  // At the 0.3 a listening hold asks for, that reads as being startled every
  // few seconds.
  const json = vrm10() as Record<string, unknown>;
  const ext = json.extensions as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
  ext.VRMC_vrm.expressions.preset.surprised = { morphTargetBinds: [{ node: 1, index: 5, weight: 1 }] };
  const r = parseVrm(buildGlb({ json }), "sample");
  const frame = new VrmBackend(r).frame({ state: "listening", at: 0, gestures: [held("brow_raise")] });
  assert.equal(frame.expressions.surprised, undefined);
  assert.ok(frame.dropped.some((d) => /brow_raise/.test(d)));
});

test("a custom expression whose name mentions brows is found by the fallback", () => {
  const json = vrm10() as Record<string, unknown>;
  const ext = json.extensions as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
  ext.VRMC_vrm.expressions.preset.MyBrowShape = { morphTargetBinds: [{ node: 1, index: 7, weight: 1 }] };
  const r = parseVrm(buildGlb({ json }), "sample");
  const frame = new VrmBackend(r).frame({ state: "listening", at: 0, gestures: [held("brow_raise", 0.4)] });
  assert.equal(frame.expressions.MyBrowShape, 0.4);
});

test("blink uses the blink expression, or is dropped", () => {
  const frame = new VrmBackend(rig()).frame({ state: "listening", at: 0, gestures: [held("blink", 0.7)] });
  assert.equal(frame.expressions.blink, 0.7);

  const json = vrm10() as Record<string, unknown>;
  const ext = json.extensions as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
  delete ext.VRMC_vrm.expressions.preset.blink;
  const r = parseVrm(buildGlb({ json }), "sample");
  const blind = new VrmBackend(r).frame({ state: "listening", at: 0, gestures: [held("blink")] });
  assert.deepEqual(blind.expressions, {});
  assert.ok(blind.dropped.some((d) => /blink: model has no blink expression/.test(d)));
});

test("a rig with no head bone says so instead of nodding nothing", () => {
  const r = rig({ noHeadBone: true });
  const backend = new VrmBackend(r);
  const frame = backend.frame({ state: "listening", at: 0, gestures: [held("nod")] });
  assert.deepEqual(frame.bones, {});
  assert.ok(frame.dropped.some((d) => /nod\/head_tilt: model has no head bone/.test(d)));
  assert.equal(backend.unsupportedChannels.nod, "no head bone");
  assert.equal(backend.unsupportedChannels.head_tilt, "no head bone");
});

test("a fully capable rig reports nothing unsupported", () => {
  const backend = new VrmBackend(rig({ eyes: true, jaw: true, customExpressions: ["browInnerUp"] }));
  assert.deepEqual(backend.unsupportedChannels, {});
});

test("frame is a pure function of its input", () => {
  const backend = new VrmBackend(rig({ eyes: true }));
  const input = { state: "listening" as const, at: 40, gestures: [held("nod")], mouth: 0.3 };
  const a = backend.frame(input);
  const b = backend.frame(input);
  assert.deepEqual(a, b, "the same moment twice is the same frame");
  assert.deepEqual(input.gestures, [held("nod")], "and it did not mutate its input");

  const later = backend.frame({ ...input, at: 5000 });
  assert.deepEqual(later.bones, {}, "five seconds later the gesture is over");
});

test("channels reach the frame so a caller can see what drove it", () => {
  const frame = new VrmBackend(rig()).frame({ state: "listening", at: 50, gestures: [held("nod", 0.5)] });
  assert.equal(frame.channels.nod, 0.5);
  assert.equal(frame.state, "listening");
  assert.equal(frame.at, 50);
});

test("the same backend drives a 0.x model", () => {
  // Nothing in the backend may depend on the spec version: 0.x and 1.0 are the
  // parser their problem, and the channel names are already canonical.
  const r = parseVrm(buildGlb({ json: vrm0() }), "sample");
  const frame = new VrmBackend(r).frame({ state: "listening", at: 0, gestures: [held("nod"), held("blink")] });
  assert.ok(frame.bones.head);
  assert.equal(frame.expressions.blink, 1);
  const delta = deltaOf(r, "head", frame.bones.head);
  assert.ok(Math.abs(degrees(delta) - 12) < 1e-6);
});

test("dropped reasons are deduplicated", () => {
  const json = vrm10() as Record<string, unknown>;
  const ext = json.extensions as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
  delete ext.VRMC_vrm.expressions.preset.aa;
  const r = parseVrm(buildGlb({ json }), "sample");
  const frame = new VrmBackend(r).frame({ state: "speaking", at: 0, gestures: [], mouth: 0.5 });
  assert.equal(frame.dropped.filter((d) => /mouth/.test(d)).length, 1);
});
