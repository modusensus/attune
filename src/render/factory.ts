/**
 * The catalogue of renderer backends.
 *
 * Kept apart from the backends themselves so that neither VRM nor Live2D has to
 * know the other exists. Unknown types throw: a character that says
 * type = "live2d" must not quietly get VRM, and a typo must not quietly get no
 * picture at all. Both are the "character looks broken, config looks fine"
 * failure this project keeps refusing to ship.
 *
 * The two rigs have nothing in common at the type level - one is a humanoid
 * skeleton, the other a parameter set - so the factory takes a tagged union and
 * each branch checks the tag before using it. A vrm type with a Live2D rig is a
 * programming error, not a user error, and it should be loud.
 */

import { NullBackend, RendererError, type RendererBackend } from "./backend.ts";
import { VrmBackend } from "./vrm/backend.ts";
import type { VrmRig } from "./vrm/vrm.ts";
import { Live2DBackend } from "./live2d/backend.ts";
import type { Live2DRig } from "./live2d/model3.ts";

/** Every rig kind the factory accepts. */
export type Rig = { kind: "vrm"; rig: VrmRig } | { kind: "live2d"; rig: Live2DRig };

/** Every type the factory will answer to. Used by the usage text and tests. */
export const RENDERER_TYPES = ["none", "vrm", "live2d"] as const;

export function backendFor(type: string, rig: Rig | null = null): RendererBackend {
  const normalised = type.trim().toLowerCase();
  if (normalised === "none" || normalised === "") return new NullBackend();
  if (normalised === "vrm") {
    if (!rig) throw new RendererError('renderer type "vrm" needs a model; set [renderer] model in character.toml');
    if (rig.kind !== "vrm") throw new RendererError('renderer type "vrm" was given a ' + rig.kind + " rig");
    return new VrmBackend(rig.rig);
  }
  if (normalised === "live2d") {
    if (!rig) throw new RendererError('renderer type "live2d" needs a model; set [renderer] model in character.toml');
    if (rig.kind !== "live2d") throw new RendererError('renderer type "live2d" was given a ' + rig.kind + " rig");
    return new Live2DBackend(rig.rig);
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
  const normalised = type.trim().toLowerCase();
  return normalised === "vrm" || normalised === "live2d";
}
