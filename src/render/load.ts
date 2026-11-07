/**
 * Turning [renderer] in character.toml into a backend.
 *
 * The config says two things: a type and a model path. This is where they meet
 * a file on disk. The two rig kinds are read by different loaders and share no
 * type, so the result is tagged and the printing code asks the tag before it
 * describes anything. A VRM has bones; a Live2D model has parameters; a single
 * "describe the rig" string would have to lie about one of them.
 *
 * Every failure names what was asked for. "renderer type vrm needs a model" and
 * "model file not found: C:\...\x.vrm" are different mistakes and a character
 * author can only fix the one they are told about.
 */

import type { CharacterConfig } from "../types.ts";
import type { RendererBackend } from "./backend.ts";
import { RendererError } from "./backend.ts";
import { backendFor, rendererNeedsModel, type Rig } from "./factory.ts";
import { loadRig, VrmError } from "./vrm/load.ts";
import { loadLive2DModel, Live2DError } from "./live2d/model3.ts";

export interface LoadedRenderer {
  backend: RendererBackend;
  /** Present when a model was read, absent for "none". */
  rig: Rig | null;
  /** Absolute path of the file that was read, for the startup line and reports. */
  modelPath: string | null;
}

export async function rendererFromConfig(character: CharacterConfig): Promise<LoadedRenderer> {
  const type = character.renderer.type;
  if (!rendererNeedsModel(type)) {
    return { backend: backendFor(type), rig: null, modelPath: null };
  }

  const model = character.renderer.model;
  if (!model || model === "none") {
    throw new RendererError('renderer type "' + type + '" needs a model; set [renderer] model in character.toml');
  }

  const kind = type.trim().toLowerCase();
  if (kind === "live2d") {
    let loaded;
    try {
      loaded = await loadLive2DModel(model, character.rootDir);
    } catch (err) {
      if (err instanceof Live2DError) throw new RendererError("renderer: " + err.message);
      throw err;
    }
    const rig: Rig = { kind: "live2d", rig: loaded };
    return { backend: backendFor(type, rig), rig, modelPath: loaded.modelPath };
  }

  let source;
  try {
    source = await loadRig(model, character.rootDir);
  } catch (err) {
    if (err instanceof VrmError) throw new RendererError("renderer: " + err.message);
    throw err;
  }
  const rig: Rig = { kind: "vrm", rig: source.rig };
  return { backend: backendFor(type, rig), rig, modelPath: source.path };
}

/**
 * The parenthetical the startup line prints, or empty when there is no model.
 *
 * VRM answers "1.0, 52 bones"; Live2D answers "model3, 247 params" - and says
 * "params unknown" rather than a made-up count when the model ships no
 * DisplayInfo. The point of this line is that a wrong config is visible before
 * the first word is spoken.
 */
export function describeLoadedRenderer(loaded: LoadedRenderer): string {
  if (!loaded.rig) return "";
  if (loaded.rig.kind === "vrm") {
    const rig = loaded.rig.rig;
    return rig.spec + ", " + Object.keys(rig.bones).length + " bones";
  }
  const rig = loaded.rig.rig;
  const params = rig.parametersKnown ? rig.parameters.size + " params" : "params unknown";
  return rig.spec + ", " + params;
}
