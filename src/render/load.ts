/**
 * Turning [renderer] in character.toml into a backend.
 *
 * The config says two things: a type and a model path. This is where they meet
 * a file on disk, and it is the only place that knows a VRM model has to be
 * read before a frame can be produced.
 *
 * Every failure names what was asked for. "renderer type vrm needs a model" and
 * "model file not found: C:\...\x.vrm" are different mistakes and a character
 * author can only fix the one they are told about.
 */

import type { CharacterConfig } from "../types.ts";
import type { RendererBackend } from "./backend.ts";
import { RendererError } from "./backend.ts";
import { backendFor, rendererNeedsModel } from "./factory.ts";
import { loadRig, VrmError } from "./vrm/load.ts";
import type { RigSource } from "./vrm/load.ts";

export interface LoadedRenderer {
  backend: RendererBackend;
  /** Present when a model was read, absent for "none". */
  rig: RigSource | null;
}

export async function rendererFromConfig(character: CharacterConfig): Promise<LoadedRenderer> {
  const type = character.renderer.type;
  if (!rendererNeedsModel(type)) {
    return { backend: backendFor(type), rig: null };
  }

  const model = character.renderer.model;
  if (!model || model === "none") {
    throw new RendererError('renderer type "' + type + '" needs a model; set [renderer] model in character.toml');
  }

  let rig: RigSource;
  try {
    rig = await loadRig(model, character.rootDir);
  } catch (err) {
    if (err instanceof VrmError) throw new RendererError("renderer: " + err.message);
    throw err;
  }
  return { backend: backendFor(type, rig.rig), rig };
}
