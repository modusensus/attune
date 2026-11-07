/**
 * Loading a rig from disk, and the sentence a broken config should produce.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseVrm, VrmError, type VrmRig } from "./vrm.ts";

export { VrmError };

export interface RigSource {
  path: string;
  rig: VrmRig;
}

/**
 * Read a .vrm.
 *
 * Every failure names the path. A renderer that fails to load a model is the
 * kind of error that gets swallowed by a try/catch three layers up and shows up
 * later as "the character is invisible", so the message has to be enough on its
 * own.
 */
export async function loadRig(path: string, rootDir = process.cwd()): Promise<RigSource> {
  const abs = isAbsolute(path) ? path : resolve(rootDir, path);
  if (!existsSync(abs)) {
    throw new VrmError("model file not found: " + abs);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(abs));
  } catch (err) {
    throw new VrmError("cannot read model " + abs + ": " + (err as Error).message);
  }
  if (bytes.byteLength === 0) {
    throw new VrmError("model file is empty: " + abs);
  }
  try {
    return { path: abs, rig: parseVrm(bytes, abs) };
  } catch (err) {
    if (err instanceof VrmError) throw err;
    if (err instanceof Error) throw new VrmError(abs + ": " + err.message);
    throw err;
  }
}
