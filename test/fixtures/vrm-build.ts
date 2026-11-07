/**
 * Building GLB files in memory, so the VRM tests do not need a 10 MB fixture
 * in the repository.
 *
 * A .vrm is a .glb: twelve-byte header, then length-prefixed chunks. Chunks are
 * padded to four bytes, JSON with spaces and BIN with zeroes. Everything here
 * follows that, because a parser that only works on hand-shaped input is not
 * being tested.
 */

const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export interface GlbParts {
  json: unknown;
  bin?: Uint8Array;
  /** Override the declared total length, to test truncation detection. */
  declaredLength?: number;
  version?: number;
  magic?: number;
}

function pad(body: Uint8Array, fill: number): Uint8Array {
  const remainder = body.byteLength % 4;
  if (remainder === 0) return body;
  const out = new Uint8Array(body.byteLength + (4 - remainder));
  out.set(body, 0);
  out.fill(fill, body.byteLength);
  return out;
}

function chunk(body: Uint8Array, type: number): Uint8Array {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, body.byteLength, true);
  view.setUint32(4, type, true);
  const out = new Uint8Array(8 + body.byteLength);
  out.set(header, 0);
  out.set(body, 8);
  return out;
}

export function buildGlb(parts: GlbParts): Uint8Array {
  const text = JSON.stringify(parts.json);
  const jsonBody = pad(new TextEncoder().encode(text), 0x20);
  const chunks: Uint8Array[] = [chunk(jsonBody, CHUNK_JSON)];
  if (parts.bin) chunks.push(chunk(pad(parts.bin, 0x00), CHUNK_BIN));

  const bodyLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const total = 12 + bodyLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, parts.magic ?? 0x46546c67, true);
  view.setUint32(4, parts.version ?? 2, true);
  view.setUint32(8, parts.declaredLength ?? total, true);
  let at = 12;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export interface RigOptions {
  /** Extra rotation on the head node. 0 for a normal model. */
  headRotation?: [number, number, number, number];
  /** Rotation on the hips, so the head's parent frame is not the identity. */
  hipsRotation?: [number, number, number, number];
  /** Add a jaw node and bone. */
  jaw?: boolean;
  /** Add eye nodes and bones. */
  eyes?: boolean;
  /** Extra custom expressions to declare, e.g. browInnerUp. */
  customExpressions?: string[];
  /** Leave the head node out of the humanoid table. */
  noHeadBone?: boolean;
  /** Skip the humanoid table entirely. */
  noHumanoid?: boolean;
}

/**
 * A minimal but internally consistent VRM 1.0 model.
 *
 * Node 0 is the hips root, node 1 the head parented to it, then optional eye
 * and jaw nodes. Only the fields the reader touches are present: a real file
 * also carries meshes, materials and skins, and none of that changes what a
 * bone tree is.
 */
export function vrm10(options: RigOptions = {}): unknown {
  const headChildren: number[] = [];
  const nodes: unknown[] = [
    { name: "hips", rotation: options.hipsRotation ?? [0, 0, 0, 1], children: [1] },
    { name: "head", rotation: options.headRotation ?? [0, 0, 0, 1], children: headChildren },
  ];

  const humanBones: Record<string, { node: number }> = {
    hips: { node: 0 },
  };
  if (!options.noHeadBone) humanBones.head = { node: 1 };

  if (options.eyes) {
    headChildren.push(2, 3);
    nodes.push({ name: "leftEye" });
    nodes.push({ name: "rightEye" });
    humanBones.leftEye = { node: 2 };
    humanBones.rightEye = { node: 3 };
  }
  if (options.jaw) {
    const index = nodes.length;
    headChildren.push(index);
    nodes.push({ name: "jaw" });
    humanBones.jaw = { node: index };
  }

  const preset: Record<string, unknown> = {
    blink: { morphTargetBinds: [{ node: 1, index: 0, weight: 1 }] },
    aa: { morphTargetBinds: [{ node: 1, index: 1, weight: 1 }] },
    // Declared but empty, the way 1.0 exporters emit bone-driven gaze.
    lookUp: {},
  };
  for (const name of options.customExpressions ?? []) {
    preset[name] = { morphTargetBinds: [{ node: 1, index: 2, weight: 0.5 }] };
  }

  const body: Record<string, unknown> = {
    specVersion: "1.0",
    meta: { name: "test model", authors: ["nobody"] },
    humanoid: options.noHumanoid ? {} : { humanBones },
    expressions: { preset },
    lookAt: { type: "bone", offsetFromHeadBone: [0, 0.06, 0] },
  };

  return {
    asset: { version: "2.0" },
    extensionsUsed: ["VRMC_vrm"],
    extensions: { VRMC_vrm: body },
    nodes,
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
}

/** A minimal VRM 0.x model: array human bones, blendShapeMaster, 0.x names. */
export function vrm0(): unknown {
  return {
    asset: { version: "2.0" },
    extensionsUsed: ["VRM"],
    extensions: {
      VRM: {
        meta: { title: "old model", author: "someone" },
        humanoid: {
          humanBones: [
            { bone: "hips", node: 0 },
            { bone: "head", node: 1 },
            { bone: "leftThumbProximal", node: 2 },
            { bone: "leftThumbIntermediate", node: 3 },
            { bone: "leftThumbDistal", node: 4 },
          ],
        },
        blendShapeMaster: {
          blendShapeGroups: [
            { name: "A", presetName: "a", binds: [{ mesh: 0, index: 0, weight: 100 }] },
            { name: "Blink", presetName: "blink", binds: [{ mesh: 0, index: 1, weight: 100 }] },
            { name: "LookUp", presetName: "lookup", binds: [] },
            { name: "Neutral", presetName: "neutral", binds: [] },
          ],
        },
        firstPerson: { lookAtTypeName: "Bone", firstPersonBoneOffset: { x: 0, y: 0.06, z: 0 } },
      },
    },
    nodes: [
      { name: "hips", children: [1] },
      { name: "head", children: [2, 3, 4] },
      { name: "ltp" },
      { name: "lti" },
      { name: "ltd" },
    ],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
}

/** A .glb with no VRM extension at all. */
export function plainGlb(): unknown {
  return {
    asset: { version: "2.0" },
    nodes: [{ name: "cube" }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
}
