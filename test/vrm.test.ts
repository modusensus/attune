import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalBone, canonicalExpression, describeRig, parseVrm, rigFromGlb, VrmError,
} from "../src/render/vrm/vrm.ts";
import { parseGlb } from "../src/render/vrm/glb.ts";
import { angleOf } from "../src/render/vrm/quat.ts";
import { buildGlb, plainGlb, vrm0, vrm10 } from "./fixtures/vrm-build.ts";

const rig10 = (options = {}) => parseVrm(buildGlb({ json: vrm10(options) }), "sample");
const rig0 = () => parseVrm(buildGlb({ json: vrm0() }), "sample");

test("a 1.0 file is read as 1.0 and a 0.x file as 0.x", () => {
  assert.equal(rig10().spec, "1.0");
  assert.equal(rig0().spec, "0.0");
});

test("a plain glb is refused by name, not by accident", () => {
  // The failure has to explain why: "no VRM extension" tells a character author
  // that they exported the wrong file, which "undefined is not an object" does
  // not.
  assert.throws(() => parseVrm(buildGlb({ json: plainGlb() }), "alice.glb"), VrmError);
  assert.throws(
    () => parseVrm(buildGlb({ json: plainGlb() }), "alice.glb"),
    /alice\.glb has no VRM extension \(found: none\); a plain \.glb is not a VRM/,
  );
});

test("a VRM with no humanoid table is refused with the reason", () => {
  assert.throws(() => rig10({ noHumanoid: true }), /says it is VRM 1\.0 but its humanoid has no humanBones table/);
});

test("a humanoid whose bones all point nowhere is not a rig", () => {
  const json = vrm10() as Record<string, unknown>;
  const ext = json.extensions as Record<string, Record<string, unknown>>;
  ext.VRMC_vrm.humanoid = { humanBones: { head: { node: 999 } } };
  assert.throws(() => parseVrm(buildGlb({ json }), "sample"), /humanoid with no usable bone nodes/);
});

test("state that is already canonical survives: node names and indexes agree", () => {
  const rig = rig10({ eyes: true, jaw: true });
  for (const [name, index] of Object.entries(rig.bones)) {
    const node = rig.nodes[index];
    assert.ok(node, name + " points at a node that exists");
    assert.equal(node.index, index);
  }
  assert.equal(rig.bones.head, 1);
  assert.equal(rig.nodes[rig.bones.head].name, "head");
});

test("0.x thumb bones are renamed to the 1.0 vocabulary", () => {
  // The rename matters for a hand gesture added later: it must not need a
  // second table to work on both specs.
  assert.equal(canonicalBone("leftThumbProximal"), "leftThumbMetacarpal");
  assert.equal(canonicalBone("leftThumbIntermediate"), "leftThumbProximal");
  assert.equal(canonicalBone("leftThumbDistal"), "leftThumbDistal");
  assert.equal(canonicalBone("head"), "head", "names that did not change pass through");
  const bones = rig0().bones;
  assert.ok(bones.leftThumbMetacarpal !== undefined);
  assert.ok(bones.leftThumbProximal !== undefined);
  assert.equal(bones.leftThumbIntermediate, undefined, "the 0.x name must not survive");
});

test("0.x expression presets are translated into the 1.0 names", () => {
  assert.equal(canonicalExpression("a"), "aa");
  assert.equal(canonicalExpression("i"), "ih");
  assert.equal(canonicalExpression("u"), "ou");
  assert.equal(canonicalExpression("e"), "ee");
  assert.equal(canonicalExpression("o"), "oh");
  assert.equal(canonicalExpression("joy"), "happy");
  assert.equal(canonicalExpression("sorrow"), "sad");
  assert.equal(canonicalExpression("blink_l"), "blinkLeft");
  assert.equal(canonicalExpression("lookup"), "lookUp");
  assert.equal(canonicalExpression("somethingCustom"), "somethingCustom");
  const expressions = rig0().expressions;
  assert.ok(expressions.aa, "a became aa");
  assert.ok(expressions.blink);
  assert.equal(expressions.a, undefined);
});

test("an expression with no binds is reported as unbound, not as usable", () => {
  // VRM 1.0 on bone-driven gaze emits lookUp/lookDown/... with an empty bind
  // list. Treating those as morphs would silently do nothing; the backend has
  // to see bound = false and drop the channel honestly.
  const rig = rig10();
  assert.equal(rig.expressions.lookUp.bound, false);
  assert.equal(rig.expressions.blink.bound, true);
  assert.equal(rig.expressions.aa.bound, true);
  // The 0.x file spells it "lookup"; the reader canonicalises it before the
  // backend ever asks, so both specs answer to the same key.
  assert.equal(rig0().expressions.lookUp.bound, false);
  assert.equal(rig0().expressions.neutral.bound, false);
});

test("1.0 custom expressions are read as well as presets", () => {
  const rig = rig10({ customExpressions: ["browInnerUp"] });
  assert.equal(rig.expressions.browInnerUp.kind, "preset", "they were declared in preset in the fixture");
  assert.equal(rig.expressions.browInnerUp.bound, true);
  assert.equal(rig.expressions.browInnerUp.source, "browInnerUp", "the file spelling is kept for the report");
});

test("meta is read from whichever field names the spec uses", () => {
  const one = rig10();
  assert.equal(one.meta.title, "test model", "1.0 calls the title name");
  assert.equal(one.meta.author, "nobody", "1.0 calls the author authors");
  const zero = rig0();
  assert.equal(zero.meta.title, "old model", "0.x calls the title title");
  assert.equal(zero.meta.author, "someone");
});

test("lookAt is read from both specs", () => {
  assert.equal(rig10().lookAt?.type, "bone");
  assert.deepEqual(rig10().lookAt?.offsetFromHeadBone, [0, 0.06, 0]);
  assert.equal(rig0().lookAt?.type, "Bone", "0.x spells it with a capital");
});

test("a file with no lookAt block reports none rather than an empty one", () => {
  const json = vrm10() as Record<string, unknown>;
  delete (json.extensions as Record<string, Record<string, unknown>>).VRMC_vrm.lookAt;
  const rig = parseVrm(buildGlb({ json }), "sample");
  assert.equal(rig.lookAt, null);
});

test("rest world rotations accumulate from the root down", () => {
  // hips carries no rotation, head carries a half turn about Y, so the head
  // world rotation is that half turn. This is the number the backend needs to
  // stop nodding sideways.
  const rig = rig10({ headRotation: [0, 1, 0, 0] });
  const hips = rig.restWorld[rig.bones.hips];
  assert.ok(Math.abs(angleOf(hips)) < 1e-9, "the root has no rest rotation");
  const head = rig.restWorld[rig.bones.head];
  assert.ok(Math.abs(angleOf(head) - Math.PI) < 1e-9, "the head sits at a half turn");
});

test("a child node that is never reached keeps its local rotation and says so", () => {
  const json = vrm10() as Record<string, unknown>;
  (json.nodes as unknown[]).push({ name: "floating", rotation: [0, 0, 0, 1] });
  const rig = parseVrm(buildGlb({ json }), "sample");
  assert.ok(rig.warnings.some((w) => /not reachable from the scene roots/.test(w)));
  assert.ok(rig.warnings.some((w) => /floating/.test(w)), "the warning names the nodes it had to guess about");
});

test("a node claimed by two parents keeps the first and says so", () => {
  const json = vrm10() as Record<string, unknown>;
  const nodes = json.nodes as Record<string, unknown>[];
  nodes.push({ name: "orphan", children: [1] });
  const rig = parseVrm(buildGlb({ json }), "sample");
  assert.equal(rig.nodes[1].parent, 0, "the first parent claimed it");
  assert.ok(rig.warnings.some((w) => /has two parents/.test(w)));
});

test("a node with a matrix instead of a rotation is flagged", () => {
  const json = vrm10() as Record<string, unknown>;
  const nodes = json.nodes as Record<string, unknown>[];
  delete nodes[1].rotation;
  nodes[1].matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const rig = parseVrm(buildGlb({ json }), "sample");
  assert.equal(rig.nodes[1].matrixOnly, true);
  assert.ok(rig.warnings.some((w) => /carry a matrix instead of a rotation/.test(w)));
});

test("a file with no usable scene roots falls back to parentless nodes", () => {
  const json = vrm10() as Record<string, unknown>;
  delete json.scenes;
  delete json.scene;
  const rig = parseVrm(buildGlb({ json }), "sample");
  assert.deepEqual(rig.roots, [0]);
  assert.ok(rig.warnings.some((w) => /no usable scene roots/.test(w)));
});

test("a 0.x file that also carries VRMC_vrm is read as 1.0 and says which it used", () => {
  const json = vrm10() as Record<string, unknown>;
  (json.extensions as Record<string, unknown>).VRM = { meta: { title: "old" }, humanoid: { humanBones: [] } };
  json.extensionsUsed = ["VRM", "VRMC_vrm"];
  const rig = parseVrm(buildGlb({ json }), "sample");
  assert.equal(rig.spec, "1.0");
  assert.ok(rig.warnings.some((w) => /carries both VRM and VRMC_vrm/.test(w)));
});

test("rigFromGlb accepts an already-parsed container", () => {
  const glb = parseGlb(buildGlb({ json: vrm10() }), "sample");
  const rig = rigFromGlb(glb, "sample");
  assert.equal(rig.spec, "1.0");
  assert.equal(rig.bytes, glb.bytes);
});

test("describeRig states the numbers a person would check", () => {
  const lines = describeRig(rig10({ eyes: true, jaw: true }));
  const text = lines.join("\n");
  assert.match(text, /spec: +VRM 1\.0/);
  assert.match(text, /title: +test model by nobody/);
  assert.match(text, /nodes: +5 \(1 scene root\(s\)\)/);
  assert.match(text, /bones: +5 humanoid/);
  assert.match(text, /expressions: 3 defined, 2 with binds \(unbound: lookUp\)/);
  assert.match(text, /lookAt: +bone/);
});

test("describeRig admits an untitled model instead of printing a blank", () => {
  const json = vrm10() as Record<string, unknown>;
  (json.extensions as Record<string, Record<string, unknown>>).VRMC_vrm.meta = {};
  const text = describeRig(parseVrm(buildGlb({ json }), "sample")).join("\n");
  assert.match(text, /\(untitled\)/);
});
