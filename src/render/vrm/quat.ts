/**
 * The only maths the 3D backend needs, written out because the project has no
 * dependencies.
 *
 * Rotations are quaternions in glTF's convention: right-handed, radians,
 * composed so that multiply(a, b) means "apply b first, then a" - the same
 * order glTF uses when it says a node's world transform is parent * local.
 *
 * Written here rather than pulled from a vector library for the usual reason
 * this project has no dependencies: a quaternion multiply is twelve lines, and
 * anything larger would be a dependency's feature set, not ours.
 */

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

export class QuatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuatError";
  }
}

export function quat(x: number, y: number, z: number, w: number): Quat {
  return { x, y, z, w };
}

/** a * b: b is applied first, then a. */
export function multiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** The inverse rotation, for unit quaternions only. */
export function conjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export function normalize(q: Quat): Quat {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  if (!(n > 0)) throw new QuatError("cannot normalise a zero quaternion");
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

/**
 * A rotation of `radians` about `axis`.
 *
 * The axis does not have to be unit length, but it does have to point
 * somewhere: a zero axis is a bug in the caller, not a rotation of zero, and
 * silently returning the identity would hide it.
 */
export function fromAxisAngle(axis: Vec3, radians: number): Quat {
  const len = Math.hypot(axis.x, axis.y, axis.z);
  if (!(len > 0)) throw new QuatError("cannot rotate about a zero-length axis");
  const half = radians / 2;
  const s = Math.sin(half) / len;
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(half) };
}

export function axisVector(axis: "x" | "y" | "z"): Vec3 {
  if (axis === "x") return { x: 1, y: 0, z: 0 };
  if (axis === "y") return { x: 0, y: 1, z: 0 };
  return { x: 0, y: 0, z: 1 };
}

/** Rotate a vector by a unit quaternion. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/**
 * How far this rotation goes, in radians, in 0..PI.
 *
 * Used by the tests to state "the head turned twelve degrees" without caring
 * which way the quaternion happened to be signed: q and -q are the same
 * rotation and exporters pick either.
 */
export function angleOf(q: Quat): number {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  if (!(n > 0)) return 0;
  const w = Math.min(1, Math.abs(q.w / n));
  return 2 * Math.acos(w);
}

export function isIdentity(q: Quat, epsilon = 1e-6): boolean {
  return Math.hypot(q.x, q.y, q.z) < epsilon;
}

/** glTF writes rotations as [x, y, z, w]; anything else means "unrotated". */
export function fromArray(a: readonly number[] | undefined | null): Quat {
  if (!a || a.length < 4) return IDENTITY;
  for (const v of a) {
    if (typeof v !== "number" || !Number.isFinite(v)) return IDENTITY;
  }
  return normalize({ x: a[0], y: a[1], z: a[2], w: a[3] });
}

export function toArray(q: Quat): [number, number, number, number] {
  return [q.x, q.y, q.z, q.w];
}
