/**
 * Reading a Live2D Cubism model declaration.
 *
 * What this file can and cannot know is worth stating plainly, because the
 * rest of the backend depends on it:
 *
 *   - model3.json is JSON. It says where the moc3 is, which textures, which
 *     motion groups, and - in Groups - which parameters the model wants used
 *     for eye blink and lip sync. All of that is read here.
 *   - moc3 is a binary Cubism format. We do not parse it. We check the magic
 *     number and the size and stop there. Reading parameter ranges out of it
 *     would mean reimplementing a proprietary format, and then everything
 *     downstream would depend on my reading of that format being right.
 *   - cdi3.json (DisplayInfo) is JSON and lists every parameter id with a
 *     human name. That is how the backend knows which parameters exist
 *     without touching the moc3. It is optional in the format, so its
 *     absence is a state to report, not an error to throw - see
 *     parametersKnown.
 */

import { open, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export class Live2DError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Live2DError";
  }
}

export interface Live2DParameter {
  id: string;
  /** Human name from the cdi3, so a report can say 角度 Y instead of ParamAngleY. */
  name: string;
  group: string;
}

export interface Live2DMotion {
  file: string;
  fadeIn: number;
  fadeOut: number;
}

export interface Live2DRig {
  /** The container we validated. Not a Cubism version - that lives in the moc3. */
  spec: "model3";
  /** Absolute path of the .model3.json. */
  modelPath: string;
  mocPath: string;
  mocBytes: number;
  textures: string[];
  physics: string | null;
  displayInfo: string | null;
  /** Parameter id -> what the artist calls it. Empty when parametersKnown is false. */
  parameters: Map<string, Live2DParameter>;
  /**
   * False when the model ships no DisplayInfo. It is still perfectly usable -
   * the Cubism standard parameter names are what almost every model uses - but
   * nothing here can verify that, so the backend says so instead of pretending.
   */
  parametersKnown: boolean;
  /** From Groups[Target=Parameter][Name=EyeBlink]. Usually the two eye-open parameters. */
  eyeBlinkIds: string[];
  /** From Groups[...Name=LipSync]. Frequently empty - see lipSyncParameters(). */
  lipSyncIds: string[];
  motions: Record<string, Live2DMotion[]>;
  expressions: { name: string; file: string }[];
  hitAreas: string[];
}

/** The parts of a model3.json that this engine actually reads. */
export interface Model3Spec {
  moc: string;
  textures: string[];
  physics: string | null;
  displayInfo: string | null;
  eyeBlinkIds: string[];
  lipSyncIds: string[];
  motions: Record<string, Live2DMotion[]>;
  expressions: { name: string; file: string }[];
  hitAreas: string[];
}

/**
 * Parse the declaration. Pure: no disk, so a broken file can be tested without
 * writing one. Every message starts with the file it came from.
 */
export function parseModel3(text: string, where: string): Model3Spec {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Live2DError(where + ": not valid JSON: " + (err as Error).message);
  }
  if (!isObject(doc)) throw new Live2DError(where + ": a model3.json must be a JSON object");

  const refs = doc.FileReferences;
  if (!isObject(refs)) {
    throw new Live2DError(where + ": has no FileReferences (this is not a model3.json)");
  }
  const moc = refs.Moc;
  if (typeof moc !== "string" || moc.length === 0) {
    throw new Live2DError(where + ": FileReferences.Moc is missing");
  }

  const textures = Array.isArray(refs.Textures)
    ? refs.Textures.filter((t): t is string => typeof t === "string" && t.length > 0)
    : [];

  const groups = Array.isArray(doc.Groups) ? doc.Groups.filter(isObject) : [];
  const groupIds = (name: string): string[] => {
    const found = groups.find((g) => g.Target === "Parameter" && g.Name === name);
    if (!found || !Array.isArray(found.Ids)) return [];
    return found.Ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  };

  const motions: Record<string, Live2DMotion[]> = {};
  if (isObject(refs.Motions)) {
    for (const [group, list] of Object.entries(refs.Motions)) {
      if (!Array.isArray(list)) continue;
      const parsed: Live2DMotion[] = [];
      for (const item of list) {
        if (!isObject(item) || typeof item.File !== "string" || item.File.length === 0) continue;
        parsed.push({
          file: item.File,
          fadeIn: numberOf(item.FadeInTime, 1),
          fadeOut: numberOf(item.FadeOutTime, 1),
        });
      }
      if (parsed.length) motions[group] = parsed;
    }
  }

  const expressions: { name: string; file: string }[] = [];
  if (Array.isArray(refs.Expressions)) {
    for (const item of refs.Expressions) {
      if (!isObject(item) || typeof item.File !== "string") continue;
      const name = typeof item.Name === "string" && item.Name.length ? item.Name : item.File;
      expressions.push({ name, file: item.File });
    }
  }

  const hitAreas = Array.isArray(doc.HitAreas)
    ? doc.HitAreas.filter(isObject).map((h) => String(h.Name ?? h.Id ?? "")).filter((n) => n.length > 0)
    : [];

  return {
    moc,
    textures,
    physics: typeof refs.Physics === "string" && refs.Physics.length > 0 ? refs.Physics : null,
    displayInfo: typeof refs.DisplayInfo === "string" && refs.DisplayInfo.length > 0 ? refs.DisplayInfo : null,
    eyeBlinkIds: groupIds("EyeBlink"),
    lipSyncIds: groupIds("LipSync"),
    motions,
    expressions,
    hitAreas,
  };
}

/**
 * Read a model3.json from disk and work out what it can drive.
 *
 * Every failure names the absolute path it looked at: "the character is
 * invisible" is not a debuggable symptom, and a swallowed error three layers up
 * is how these things are usually found out.
 */
export async function loadLive2DModel(path: string, rootDir = process.cwd()): Promise<Live2DRig> {
  const modelPath = isAbsolute(path) ? path : resolve(rootDir, path);
  if (!existsSync(modelPath)) throw new Live2DError("model file not found: " + modelPath);

  let text: string;
  try {
    text = await readFile(modelPath, "utf8");
  } catch (err) {
    throw new Live2DError("cannot read model " + modelPath + ": " + (err as Error).message);
  }
  const spec = parseModel3(text, modelPath);
  const dir = dirname(modelPath);

  const mocPath = resolve(dir, spec.moc);
  const moc = await readMoc3(mocPath);

  const displayInfo = spec.displayInfo ? resolve(dir, spec.displayInfo) : null;
  const parsed = displayInfo ? await readDisplayInfo(displayInfo) : null;

  return {
    spec: "model3",
    modelPath,
    mocPath,
    mocBytes: moc.bytes,
    textures: spec.textures.map((t) => resolve(dir, t)),
    physics: spec.physics ? resolve(dir, spec.physics) : null,
    displayInfo,
    parameters: parsed ?? new Map<string, Live2DParameter>(),
    parametersKnown: parsed !== null,
    eyeBlinkIds: spec.eyeBlinkIds,
    lipSyncIds: spec.lipSyncIds,
    motions: Object.fromEntries(
      Object.entries(spec.motions).map(([group, list]) => [
        group,
        list.map((m) => ({ ...m, file: resolve(dir, m.file) })),
      ]),
    ),
    expressions: spec.expressions.map((e) => ({ name: e.name, file: resolve(dir, e.file) })),
    hitAreas: spec.hitAreas,
  };
}

/**
 * Which parameters carry lip sync.
 *
 * The LipSync group is empty in a surprising number of models - the whale girl
 * model this backend was written against declares one and leaves it blank - so
 * an empty group means "use the standard name", not "this model cannot open its
 * mouth". Getting that backwards would silently kill the mouth.
 */
export function lipSyncParameters(rig: Live2DRig): string[] {
  if (rig.lipSyncIds.length) return rig.lipSyncIds.slice();
  return ["ParamMouthOpenY"];
}

/** The one-line-per-fact report the acceptance scripts print. */
export function describeLive2D(rig: Live2DRig): string[] {
  const out: string[] = [];
  out.push("model:    " + rig.modelPath);
  out.push("moc3:     " + rig.mocPath + "  (" + rig.mocBytes + " bytes)");
  out.push("textures: " + (rig.textures.length ? rig.textures.length + " file(s)" : "(none declared)"));
  out.push("physics:  " + (rig.physics ?? "(none)"));
  out.push(
    "params:   " +
      (rig.parametersKnown ? rig.parameters.size + " declared" : "not declared (no DisplayInfo; standard names assumed)"),
  );
  out.push("eyeblink: " + (rig.eyeBlinkIds.length ? rig.eyeBlinkIds.join(", ") : "(no EyeBlink group)"));
  out.push(
    "lipsync:  " +
      (rig.lipSyncIds.length ? rig.lipSyncIds.join(", ") : "(group declared empty; falling back to ParamMouthOpenY)"),
  );
  const motionGroups = Object.keys(rig.motions);
  out.push("motions:  " + (motionGroups.length ? motionGroups.length + " group(s): " + motionGroups.join(", ") : "(none)"));
  out.push("exp3:     " + (rig.expressions.length ? rig.expressions.length + " expression(s), not driven by this backend" : "(none)"));
  return out;
}

async function readMoc3(path: string): Promise<{ bytes: number }> {
  if (!existsSync(path)) throw new Live2DError("moc3 file not found: " + path);
  let handle;
  try {
    handle = await open(path, "r");
  } catch (err) {
    throw new Live2DError("cannot open moc3 " + path + ": " + (err as Error).message);
  }
  try {
    const stat = await handle.stat();
    if (stat.size === 0) throw new Live2DError("moc3 file is empty: " + path);
    const head = Buffer.alloc(4);
    const read = await handle.read(head, 0, 4, 0);
    if (read.bytesRead < 4) throw new Live2DError("moc3 file is truncated: " + path);
    const magic = head.toString("latin1");
    if (magic !== "MOC3") {
      throw new Live2DError("not a Cubism moc3 (magic was " + JSON.stringify(magic) + "): " + path);
    }
    return { bytes: stat.size };
  } finally {
    await handle.close();
  }
}

async function readDisplayInfo(path: string): Promise<Map<string, Live2DParameter> | null> {
  if (!existsSync(path)) throw new Live2DError("display info not found: " + path);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Live2DError("cannot read display info " + path + ": " + (err as Error).message);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Live2DError(path + ": display info is not valid JSON: " + (err as Error).message);
  }
  if (!isObject(doc)) throw new Live2DError(path + ": display info must be a JSON object");
  const out = new Map<string, Live2DParameter>();
  const list = Array.isArray(doc.Parameters) ? doc.Parameters : [];
  for (const item of list) {
    if (!isObject(item) || typeof item.Id !== "string" || item.Id.length === 0) continue;
    out.set(item.Id, {
      id: item.Id,
      name: typeof item.Name === "string" ? item.Name : item.Id,
      group: typeof item.GroupId === "string" ? item.GroupId : "",
    });
  }
  return out;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
