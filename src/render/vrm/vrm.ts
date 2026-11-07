/**
 * VRM reading, both spec versions, with no dependency on three.js.
 *
 * Why parse it ourselves: the project ships zero dependencies, and a clone has
 * to run before anything is installed. What the 3D backend actually needs from
 * a model is small - the node tree, where the humanoid bones are, which
 * expressions exist, and the rest pose - and none of that is geometry.
 *
 * The one thing this file does not do is pretend. If a model has no eyebrow
 * expression, there are no eyebrows, and the report says so. Inventing a head
 * wiggle to stand in for a missing brow is how a character ends up looking
 * like a screensaver instead of like someone listening.
 */

import { parseGlb, asArray, asObject, GlbError, type GlbFile, type GltfJson } from "./glb.ts";
import { fromArray, multiply, type Quat, IDENTITY } from "./quat.ts";

export { GlbError };

/** Which spec a file speaks. 0.x and 1.0 disagree about almost every field name. */
export type VrmSpec = "0.0" | "1.0";

export interface VrmNode {
  index: number;
  name: string;
  parent: number | null;
  children: number[];
  /** Rest local rotation. Translation is read but not used for anything yet. */
  rotation: Quat;
  /** True when the node carried a matrix instead of translation/rotation/scale. */
  matrixOnly: boolean;
}

export interface VrmExpression {
  /** Canonical name, translated from the 0.x vocabulary where needed. */
  name: string;
  /** The name as the file spelled it, so a report can be checked against the file. */
  source: string;
  kind: "preset" | "custom";
  /**
   * False for definitions with no binds at all. VRM 1.0 exporters emit
   * lookUp/lookDown/lookLeft/lookRight this way on bone-driven gaze, and
   * treating those as usable morphs would silently do nothing.
   */
  bound: boolean;
}

export interface VrmLookAt {
  type: string;
  /** Present in 1.0, where the eye offset is given explicitly. */
  offsetFromHeadBone: [number, number, number] | null;
}

export interface VrmMeta {
  title: string;
  author: string;
  /** Raw permission fields; the shape differs between specs so they stay loose. */
  raw: GltfJson;
}

export interface VrmRig {
  spec: VrmSpec;
  meta: VrmMeta;
  nodes: VrmNode[];
  roots: number[];
  /** Canonical bone name -> node index. Names follow the 1.0 vocabulary. */
  bones: Record<string, number>;
  expressions: Record<string, VrmExpression>;
  lookAt: VrmLookAt | null;
  /**
   * Rest world rotation per node index. This is the whole reason the backend
   * can nod without a crooked neck: a VRM 1.0 head often sits at a half-turn in
   * its own local space, so a rotation applied on the local axis points
   * sideways in the world.
   */
  restWorld: Quat[];
  /** Everything the file did that the reader had to work around, in plain words. */
  warnings: string[];
  bytes: number;
}

export class VrmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VrmError";
  }
}

/**
 * 0.x thumb bones are named Proximal/Intermediate/Distal; 1.0 renamed them to
 * Metacarpal/Proximal/Distal. Fingers do not appear in any gesture this engine
 * emits yet, but normalising now means a hand gesture added later works on both
 * specs without a second look at this table.
 */
const BONE_ALIASES: Record<string, string> = {
  leftThumbProximal: "leftThumbMetacarpal",
  leftThumbIntermediate: "leftThumbProximal",
  leftThumbDistal: "leftThumbDistal",
  rightThumbProximal: "rightThumbMetacarpal",
  rightThumbIntermediate: "rightThumbProximal",
  rightThumbDistal: "rightThumbDistal",
};

/** 0.x preset names translated into the 1.0 vocabulary. */
const EXPRESSION_ALIASES: Record<string, string> = {
  neutral: "neutral",
  a: "aa",
  i: "ih",
  u: "ou",
  e: "ee",
  o: "oh",
  blink: "blink",
  blink_l: "blinkLeft",
  blink_r: "blinkRight",
  joy: "happy",
  fun: "relaxed",
  sorrow: "sad",
  angry: "angry",
  lookup: "lookUp",
  lookdown: "lookDown",
  lookleft: "lookLeft",
  lookright: "lookRight",
};

export function canonicalBone(name: string): string {
  return BONE_ALIASES[name] ?? name;
}

export function canonicalExpression(name: string): string {
  return EXPRESSION_ALIASES[name] ?? name;
}

/** Read a .vrm from bytes. Throws VrmError for anything that is not a VRM. */
export function parseVrm(bytes: Uint8Array, label = "model"): VrmRig {
  const glb = parseGlb(bytes, label);
  return rigFromGlb(glb, label);
}

export function rigFromGlb(glb: GlbFile, label = "model"): VrmRig {
  const json = glb.json;
  const warnings: string[] = [];

  const extensions = asObject(json.extensions);
  const vrm10 = asObject(extensions.VRMC_vrm);
  const vrm0 = asObject(extensions.VRM);
  const specVersion10 = typeof vrm10.specVersion === "string" ? vrm10.specVersion : null;
  const hasVrm10 = Object.keys(vrm10).length > 0;
  const hasVrm0 = Object.keys(vrm0).length > 0;

  let spec: VrmSpec;
  let body: GltfJson;
  if (hasVrm10) {
    spec = "1.0";
    body = vrm10;
    if (specVersion10 && specVersion10 !== "1.0") {
      warnings.push("VRMC_vrm says specVersion " + specVersion10 + "; reading it as 1.0 anyway");
    }
    if (hasVrm0) warnings.push("file carries both VRM and VRMC_vrm extensions; using VRMC_vrm");
  } else if (hasVrm0) {
    spec = "0.0";
    body = vrm0;
  } else {
    const used = asArray(json.extensionsUsed).map(String);
    throw new VrmError(
      label + " has no VRM extension (found: " + (used.length ? used.join(", ") : "none") +
        "); a plain .glb is not a VRM and has no humanoid to drive",
    );
  }

  const nodes = readNodes(json, warnings);
  const roots = readRoots(json, nodes, warnings);

  const humanoid = asObject(body.humanoid);
  const bones = readHumanBones(humanoid, spec, nodes, label);

  const expressions = spec === "1.0" ? readExpressions10(body) : readExpressions0(body);
  const lookAt = readLookAt(body, spec);

  const restWorld = computeRestWorld(nodes, roots, warnings);

  return {
    spec,
    meta: readMeta(body, spec),
    nodes,
    roots,
    bones,
    expressions,
    lookAt,
    restWorld,
    warnings,
    bytes: glb.bytes,
  };
}

function readNodes(json: GltfJson, warnings: string[]): VrmNode[] {
  const raw = asArray(json.nodes);
  const nodes: VrmNode[] = raw.map((entry, index) => {
    const n = asObject(entry);
    const name = typeof n.name === "string" ? n.name : "node" + index;
    const rotation = fromArray(n.rotation as number[] | undefined);
    const matrixOnly = n.matrix !== undefined && n.rotation === undefined;
    return {
      index,
      name,
      parent: null,
      children: asArray(n.children).map((c) => Number(c)).filter((c) => Number.isInteger(c)),
      rotation,
      matrixOnly,
    };
  });

  for (const node of nodes) {
    for (const child of node.children) {
      if (child < 0 || child >= nodes.length) {
        warnings.push("node " + node.index + " (" + node.name + ") lists a child " + child + " that does not exist");
        continue;
      }
      if (nodes[child].parent !== null && nodes[child].parent !== node.index) {
        warnings.push(
          "node " + child + " (" + nodes[child].name + ") has two parents, " +
            nodes[child].parent + " and " + node.index + "; keeping the first",
        );
        continue;
      }
      nodes[child].parent = node.index;
    }
  }
  return nodes;
}

function readRoots(json: GltfJson, nodes: VrmNode[], warnings: string[]): number[] {
  const scenes = asArray(json.scenes);
  const sceneIndex = typeof json.scene === "number" ? json.scene : 0;
  const scene = asObject(scenes[sceneIndex] ?? scenes[0]);
  const declared = asArray(scene.nodes).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < nodes.length);

  if (declared.length) return declared;

  const derived = nodes.filter((n) => n.parent === null).map((n) => n.index);
  if (derived.length) warnings.push("no usable scene roots in the file; treating every parentless node as a root");
  return derived;
}

function readHumanBones(humanoid: GltfJson, spec: VrmSpec, nodes: VrmNode[], label: string): Record<string, number> {
  const raw = humanoid.humanBones;
  const bones: Record<string, number> = {};

  const put = (name: string, nodeIndex: unknown) => {
    const idx = Number(nodeIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= nodes.length) return;
    bones[canonicalBone(name)] = idx;
  };

  if (Array.isArray(raw)) {
    // 0.x: an array of { bone, node }.
    for (const entry of raw) {
      const e = asObject(entry);
      const name = e.bone;
      if (typeof name !== "string") continue;
      put(name, e.node);
    }
  } else if (raw && typeof raw === "object") {
    // 1.0: an object keyed by bone name.
    for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
      put(name, asObject(entry).node);
    }
  } else {
    throw new VrmError(label + " says it is VRM " + spec + " but its humanoid has no humanBones table");
  }

  if (!Object.keys(bones).length) {
    throw new VrmError(label + " has a humanoid with no usable bone nodes; there is nothing to drive");
  }
  return bones;
}

function readExpressions10(body: GltfJson): Record<string, VrmExpression> {
  const expressions = asObject(body.expressions);
  const out: Record<string, VrmExpression> = {};

  for (const kind of ["preset", "custom"] as const) {
    const table = asObject(expressions[kind]);
    for (const [name, entry] of Object.entries(table)) {
      const e = asObject(entry);
      const binds = asArray(e.morphTargetBinds);
      out[canonicalExpression(name)] = {
        name: canonicalExpression(name),
        source: name,
        kind,
        bound: binds.length > 0,
      };
    }
  }
  return out;
}

function readExpressions0(body: GltfJson): Record<string, VrmExpression> {
  const master = asObject(body.blendShapeMaster);
  const groups = asArray(master.blendShapeGroups);
  const out: Record<string, VrmExpression> = {};

  for (const entry of groups) {
    const g = asObject(entry);
    const source = typeof g.presetName === "string" && g.presetName ? g.presetName : String(g.name ?? "");
    if (!source) continue;
    const name = canonicalExpression(source);
    out[name] = {
      name,
      source,
      kind: "preset",
      bound: asArray(g.binds).length > 0,
    };
  }
  return out;
}

function readLookAt(body: GltfJson, spec: VrmSpec): VrmLookAt | null {
  if (spec === "1.0") {
    const lookAt = asObject(body.lookAt);
    if (!Object.keys(lookAt).length) return null;
    const offset = asArray(lookAt.offsetFromHeadBone).map(Number);
    return {
      type: typeof lookAt.type === "string" ? lookAt.type : "unknown",
      offsetFromHeadBone:
        offset.length === 3 && offset.every((v) => Number.isFinite(v))
          ? [offset[0], offset[1], offset[2]]
          : null,
    };
  }

  const fp = asObject(body.firstPerson);
  if (!Object.keys(fp).length) return null;
  const offset = asArray(fp.firstPersonBoneOffset).map(Number);
  return {
    type: typeof fp.lookAtTypeName === "string" ? fp.lookAtTypeName : "unknown",
    offsetFromHeadBone:
      offset.length === 3 && offset.every((v) => Number.isFinite(v)) ? [offset[0], offset[1], offset[2]] : null,
  };
}

/**
 * Title and author, whichever spec the file speaks.
 *
 * 1.0 renamed the fields: what 0.x calls `title` and `author` is `name` and
 * `authors` (a list). Reading only the 0.x names leaves every 1.0 model in the
 * report as "(untitled)", which is a small thing that makes a 10 MB file look
 * like it failed to load.
 */
function readMeta(body: GltfJson, spec: VrmSpec): VrmMeta {
  const meta = asObject(body.meta);
  const title =
    (typeof meta.title === "string" && meta.title) ||
    (typeof meta.name === "string" && meta.name) ||
    "";
  const authors = asArray(meta.authors).map(String).filter(Boolean);
  const author =
    (typeof meta.author === "string" && meta.author) ||
    authors.join(", ") ||
    "";
  return { title, author, raw: meta };
}

/**
 * Rest world rotation for every node, accumulated from the roots down.
 *
 * Nodes unreachable from a scene root keep their local rotation as their world
 * one, and say so: a humanoid bone that the scene graph forgot is a file
 * problem, and silently giving it an identity world rotation would make the
 * first gesture point in a random direction.
 */
function computeRestWorld(nodes: VrmNode[], roots: number[], warnings: string[]): Quat[] {
  const world: Quat[] = new Array(nodes.length).fill(IDENTITY);
  const seen = new Set<number>();
  const stack: number[] = [];

  for (const root of roots) {
    if (root < 0 || root >= nodes.length) continue;
    world[root] = nodes[root].rotation;
    stack.push(root);
  }

  while (stack.length) {
    const index = stack.pop() as number;
    if (seen.has(index)) continue;
    seen.add(index);
    const node = nodes[index];
    for (const child of node.children) {
      if (child < 0 || child >= nodes.length || seen.has(child)) continue;
      world[child] = multiply(world[index], nodes[child].rotation);
      stack.push(child);
    }
  }

  const unreachable = nodes.filter((n) => !seen.has(n.index));
  if (unreachable.length) {
    warnings.push(
      unreachable.length + " node(s) are not reachable from the scene roots and keep their local rest rotation (" +
        unreachable.slice(0, 5).map((n) => n.name).join(", ") + (unreachable.length > 5 ? ", ..." : "") + ")",
    );
    for (const n of unreachable) world[n.index] = n.rotation;
  }

  const matrixOnly = nodes.filter((n) => n.matrixOnly);
  if (matrixOnly.length) {
    warnings.push(
      matrixOnly.length + " node(s) carry a matrix instead of a rotation, so their rest rotation is read as identity (" +
        matrixOnly.slice(0, 5).map((n) => n.name).join(", ") + (matrixOnly.length > 5 ? ", ..." : "") + ")",
    );
  }

  return world;
}

/** A short human-readable inventory. Feeds the acceptance script and the logs. */
export function describeRig(rig: VrmRig): string[] {
  const lines: string[] = [];
  lines.push("spec:     VRM " + rig.spec);
  lines.push("bytes:    " + rig.bytes);
  lines.push("title:    " + (rig.meta.title || "(untitled)") + (rig.meta.author ? " by " + rig.meta.author : ""));
  lines.push("nodes:    " + rig.nodes.length + " (" + rig.roots.length + " scene root(s))");
  lines.push("bones:    " + Object.keys(rig.bones).length + " humanoid");
  const expressions = Object.values(rig.expressions);
  const bound = expressions.filter((e) => e.bound);
  lines.push(
    "expressions: " + expressions.length + " defined, " + bound.length + " with binds" +
      (expressions.length !== bound.length
        ? " (unbound: " + expressions.filter((e) => !e.bound).map((e) => e.source).join(", ") + ")"
        : ""),
  );
  lines.push("lookAt:   " + (rig.lookAt ? rig.lookAt.type : "none"));
  for (const w of rig.warnings) lines.push("warning:  " + w);
  return lines;
}
