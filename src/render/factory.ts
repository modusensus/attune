/**
 * The catalogue of renderer backends.
 *
 * Kept apart from the backends themselves so that neither VRM nor a future
 * Live2D has to know the other exists. Unknown types throw: a character that
 * says type = "live2d" must not quietly get VRM, and a typo must not quietly
 * get no picture at all. Both are the "character looks broken, config looks
 * fine" failure this project keeps refusing to ship.
 */

import { NullBackend, RendererError, type RendererBackend } from "./backend.ts";
import { VrmBackend } from "./vrm/backend.ts";
import type { VrmRig } from "./vrm/vrm.ts";

/** Every type the factory will answer to. Used by the usage text and tests. */
export const RENDERER_TYPES = ["none", "vrm", "live2d"] as const;

export function backendFor(type: string, rig: VrmRig | null = null): RendererBackend {
  const normalised = type.trim().toLowerCase();
  if (normalised === "none" || normalised === "") return new NullBackend();
  if (normalised === "vrm") {
    if (!rig) throw new RendererError('renderer type "vrm" needs a model; set [renderer] model in character.toml');
    return new VrmBackend(rig);
  }
  if (normalised === "live2d") {
    throw new RendererError('renderer type "live2d" is not implemented yet; use "vrm" or "none"');
  }
  throw new RendererError('unknown renderer type: "' + type + '" (expected none, vrm, or live2d)');
}

/**
 * Does this renderer type need a model file on disk?
 *
 * Asked before loading, so that [renderer] type = "vrm" with no model says
 * "needs a model" instead of "model file not found: .../none".
 */
export function rendererNeedsModel(type: string): boolean {
  return type.trim().toLowerCase() === "vrm";
}
