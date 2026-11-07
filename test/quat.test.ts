import assert from "node:assert/strict";
import { test } from "node:test";
import {
  angleOf, axisVector, conjugate, fromArray, fromAxisAngle, IDENTITY, isIdentity,
  multiply, normalize, quat, QuatError, rotate, toArray,
} from "../src/render/vrm/quat.ts";

const HALF_TURN = fromAxisAngle(axisVector("y"), Math.PI);

test("multiply applies the right-hand rotation first", () => {
  // Rotate x by 90 about Y, then by 90 about Z. Applying the other order on
  // the same axis would give a different point, which is the whole point of
  // getting the order right: glTF says world = parent * local.
  const aboutY = fromAxisAngle(axisVector("y"), Math.PI / 2);
  const aboutZ = fromAxisAngle(axisVector("z"), Math.PI / 2);
  const forward = rotate(aboutZ, rotate(aboutY, { x: 1, y: 0, z: 0 }));
  const combined = rotate(multiply(aboutZ, aboutY), { x: 1, y: 0, z: 0 });
  assert.ok(Math.abs(forward.x - combined.x) < 1e-9);
  assert.ok(Math.abs(forward.y - combined.y) < 1e-9);
  assert.ok(Math.abs(forward.z - combined.z) < 1e-9);

  const reversed = rotate(multiply(aboutY, aboutZ), { x: 1, y: 0, z: 0 });
  assert.ok(Math.abs(reversed.z - combined.z) > 0.1, "swapping the order must change the result");
});

test("a quarter turn about Y sends +X to -Z", () => {
  const q = fromAxisAngle(axisVector("y"), Math.PI / 2);
  const v = rotate(q, { x: 1, y: 0, z: 0 });
  assert.ok(Math.abs(v.x) < 1e-9);
  assert.ok(Math.abs(v.y) < 1e-9);
  assert.ok(Math.abs(v.z + 1) < 1e-9, "right-handed: +X rotates toward -Z");
});

test("conjugate undoes the rotation", () => {
  const q = fromAxisAngle(axisVector("x"), 0.7);
  const back = rotate(multiply(q, conjugate(q)), { x: 0.3, y: -0.4, z: 0.5 });
  assert.ok(Math.abs(back.x - 0.3) < 1e-9);
  assert.ok(Math.abs(back.y + 0.4) < 1e-9);
  assert.ok(Math.abs(back.z - 0.5) < 1e-9);
});

test("angleOf reads the size of a rotation, ignoring which way it is signed", () => {
  const q = fromAxisAngle(axisVector("x"), 0.5);
  assert.ok(Math.abs(angleOf(q) - 0.5) < 1e-9);
  // q and -q are the same rotation; exporters emit either.
  const negated = quat(-q.x, -q.y, -q.z, -q.w);
  assert.ok(Math.abs(angleOf(negated) - 0.5) < 1e-9);
  assert.equal(angleOf(IDENTITY), 0);
});

test("a non-unit axis still rotates by the angle asked for", () => {
  const a = fromAxisAngle({ x: 0, y: 2.5, z: 0 }, Math.PI / 2);
  const b = fromAxisAngle(axisVector("y"), Math.PI / 2);
  assert.ok(Math.abs(angleOf(a) - angleOf(b)) < 1e-9);
  assert.ok(Math.abs(a.y - b.y) < 1e-9, "the axis is normalised, not just scaled");
});

test("a zero-length axis is a caller bug, not a zero rotation", () => {
  assert.throws(() => fromAxisAngle({ x: 0, y: 0, z: 0 }, 1), QuatError);
  assert.throws(() => fromAxisAngle({ x: 0, y: 0, z: 0 }, 1), /zero-length axis/);
});

test("a zero quaternion cannot be normalised", () => {
  assert.throws(() => normalize(quat(0, 0, 0, 0)), QuatError);
  assert.throws(() => normalize(quat(0, 0, 0, 0)), /zero quaternion/);
});

test("fromArray normalises and falls back to identity", () => {
  const q = fromArray([0, 2, 0, 0]);
  assert.ok(Math.abs(q.y - 1) < 1e-9, "scaled input is normalised");
  assert.deepEqual(fromArray(undefined), IDENTITY);
  assert.deepEqual(fromArray(null), IDENTITY);
  assert.deepEqual(fromArray([0, 0, 1]), IDENTITY, "three numbers is not a quaternion");
  assert.deepEqual(fromArray([0, 0, 0, Number.NaN]), IDENTITY, "NaN is not a rotation");
});

test("toArray publishes glTF order x,y,z,w", () => {
  assert.deepEqual(toArray(quat(1, 2, 3, 4)), [1, 2, 3, 4]);
});

test("isIdentity looks at the imaginary part only", () => {
  assert.ok(isIdentity(IDENTITY));
  assert.ok(isIdentity(quat(1e-12, 0, 0, 1)));
  assert.ok(!isIdentity(fromAxisAngle(axisVector("x"), 0.1)));
});

test("a half turn about Y squares to a full turn", () => {
  const full = multiply(HALF_TURN, HALF_TURN);
  assert.ok(Math.abs(angleOf(full)) < 1e-9 || Math.abs(angleOf(full) - 2 * Math.PI) < 1e-9);
  const v = rotate(full, { x: 1, y: 2, z: 3 });
  assert.ok(Math.abs(v.x - 1) < 1e-9);
  assert.ok(Math.abs(v.y - 2) < 1e-9);
  assert.ok(Math.abs(v.z - 3) < 1e-9);
});
