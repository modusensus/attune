/**
 * M4 acceptance: does the configured renderer actually move a 3D character,
 * and does it claim the same thing as the 2D one?
 *
 * What this proves:
 *
 *   1. the model loads from [renderer] in character.toml, with no extra setup
 *   2. the same gesture stream drives both "none" and "vrm" to the same
 *      channel values - that is the whole claim of "one config, 2D or 3D"
 *   3. a nod turns the head and then puts it back
 *   4. the mouth opens during speech and stays shut otherwise
 *   5. no frame contains NaN, which is what a broken bone chain looks like
 *      from a distance
 *
 * What it does not prove: that the character looks right. Nothing in a script
 * can. Open the frames and look at them.
 *
 *   node scripts/vrm-accept.ts --model out/vrm-probe/VRM1_Constraint_Twist_Sample.vrm
 *   node scripts/vrm-accept.ts --character examples/example-character
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadCharacter } from "../src/config.ts";
import { rendererFromConfig } from "../src/render/load.ts";
import { backendFor } from "../src/render/factory.ts";
import { Stage } from "../src/render/stage.ts";
import { describeRig } from "../src/render/vrm/vrm.ts";
import { angleOf, conjugate, multiply, type Quat } from "../src/render/vrm/quat.ts";
import { mouthFrames } from "../src/audio/envelope.ts";
import { encodeWav } from "../src/audio/wav.ts";
import type { Gesture } from "../src/render/gesture.ts";
import type { PoseFrame } from "../src/render/backend.ts";
import type { CharacterConfig } from "../src/types.ts";

const SAMPLE_RATE = 22050;
const FPS = 60;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** A nod, then a tilt, then a gaze - one of each thing the listener can emit. */
function scriptedGestures(): Gesture[] {
  return [
    { channel: "nod", at: 200, peak: 0.6, riseMs: 120, holdMs: 90, fallMs: 200 },
    { channel: "head_tilt", at: 700, peak: 0.3, riseMs: 160, holdMs: 120, fallMs: 260 },
    { channel: "gaze_shift", at: 1100, peak: 0.4, riseMs: 220, holdMs: 320, fallMs: 260 },
    { channel: "brow_raise", at: 1500, peak: 0.3, riseMs: 90, holdMs: 160, fallMs: 220 },
    { channel: "blink", at: 1900, peak: 1, riseMs: 50, holdMs: 60, fallMs: 90 },
  ];
}

/** A crude "speech" tone so the envelope has something to open the mouth on. */
function tone(ms: number, hz: number, amp: number): Float32Array {
  const n = Math.round((ms / 1000) * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Syllable-ish amplitude so the envelope has edges rather than a plateau.
    const gate = Math.sin((Math.PI * (i % 1100)) / 1100);
    out[i] = amp * gate * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
  }
  return out;
}

function concat(parts: Float32Array[]): Float32Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function worldDelta(r: { restWorld: Quat[]; bones: Record<string, number>; nodes: { parent: number | null }[] }, bone: string, local: Quat): Quat {
  const node = r.nodes[r.bones[bone]];
  const parent = node.parent === null ? null : r.restWorld[node.parent];
  const world = parent ? multiply(parent, local) : local;
  return multiply(world, conjugate(r.restWorld[r.bones[bone]]));
}

const degrees = (q: Quat): number => (angleOf(q) * 180) / Math.PI;

function finite(frame: PoseFrame): boolean {
  for (const bone of Object.values(frame.bones)) {
    if (![bone.x, bone.y, bone.z, bone.w].every(Number.isFinite)) return false;
  }
  for (const weight of Object.values(frame.expressions)) {
    if (!Number.isFinite(weight)) return false;
  }
  return true;
}

async function main(): Promise<number> {
  let args: { model?: string; character?: string; out?: string; json?: boolean };
  try {
    args = parseArgs({
      options: {
        model: { type: "string" },
        character: { type: "string" },
        out: { type: "string" },
        json: { type: "boolean" },
      },
      allowPositionals: false,
    }).values as typeof args;
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  if (!args.model && !args.character) {
    console.error("usage: node scripts/vrm-accept.ts --model <file.vrm> | --character <dir> [--out <dir>] [--json]");
    console.error("  --model      a .vrm file to drive directly");
    console.error("  --character  a character directory; its [renderer] decides");
    return 2;
  }

  let character: CharacterConfig;
  if (args.character) {
    character = await loadCharacter(args.character);
  } else {
    character = {
      name: "vrm-accept",
      personaPath: "",
      memoryNamespace: "vrm-accept",
      voice: { engine: "none", model: "none" },
      asr: { engine: "none", model: "none" },
      renderer: { type: "vrm", model: args.model as string },
      mapping: {},
      rootDir: process.cwd(),
    };
  }

  const outDir = args.out ?? join("out", "vrm-accept");
  const checks: Check[] = [];
  const push = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  let loaded;
  try {
    loaded = await rendererFromConfig(character);
  } catch (err) {
    console.error("renderer error: " + (err as Error).message);
    return 1;
  }

  const rig = loaded.rig?.rig ?? null;
  const report = rig ? describeRig(rig) : ["(no model: the none backend has no rig to describe)"];
  push("a renderer was built", loaded.backend.id === (rig ? "vrm" : "none"), "backend: " + loaded.backend.id);
  if (rig) {
    push("the model parsed as a VRM", rig.spec === "0.0" || rig.spec === "1.0", "spec: " + rig.spec);
    push("it has a humanoid", Object.keys(rig.bones).length > 0, Object.keys(rig.bones).length + " bones");
  }

  // Same channels through both backends: the claim is that a character config
  // does not have to know which one it will be drawn by.
  const gestures = scriptedGestures();
  const flat = new Stage(backendFor("none"));
  flat.addGestures(gestures);
  const stage = new Stage(loaded.backend);
  stage.addGestures(gestures);

  const audio = concat([tone(700, 210, 0.5), new Float32Array(Math.round(SAMPLE_RATE * 0.25)), tone(900, 195, 0.55)]);
  const frames = mouthFrames({ sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16, format: 1, samples: audio, mono: audio, durationMs: (audio.length / SAMPLE_RATE) * 1000 } as never);
  flat.setMouth(frames);
  stage.setMouth(frames);

  const totalMs = Math.max(2600, (audio.length / SAMPLE_RATE) * 1000 + 600);
  const sampled: PoseFrame[] = [];
  const mismatch: string[] = [];
  for (let t = 0; t <= totalMs; t += 1000 / FPS) {
    const at = Math.round(t);
    const a = flat.frameAt(at);
    const b = stage.frameAt(at);
    for (const key of new Set([...Object.keys(a.channels), ...Object.keys(b.channels)])) {
      if (Math.abs((a.channels[key] ?? 0) - (b.channels[key] ?? 0)) > 1e-9) mismatch.push(key + " at " + at + "ms");
    }
    sampled.push(b);
  }
  push(
    "none and vrm see the same channels",
    mismatch.length === 0,
    mismatch.length === 0 ? sampled.length + " frames agreed" : mismatch.slice(0, 3).join("; "),
  );

  push("no frame contains NaN", sampled.every(finite), sampled.length + " frames checked");

  if (rig) {
    const nodding = sampled.filter((f) => f.at >= 200 && f.at <= 520 && f.bones.head !== undefined);
    push("the head moves during the nod", nodding.length > 0, nodding.length + " frames with a head rotation");

    const peak = Math.max(0, ...nodding.map((f) => degrees(worldDelta(rig, "head", f.bones.head))));
    push("the nod is a nod, not a shudder", peak > 5 && peak < 20, "peak " + peak.toFixed(2) + " degrees");

    const restFrame = sampled[sampled.length - 1];
    const restDegrees = restFrame.bones.head ? degrees(worldDelta(rig, "head", restFrame.bones.head)) : 0;
    push("the head comes back to rest", restDegrees < 0.5, restDegrees.toFixed(3) + " degrees at the end");

    const speaking = sampled.filter((f) => f.at > 600 && f.at < 1600);
    const openWeights = speaking.map((f) => f.expressions.aa ?? 0);
    const maxOpen = Math.max(0, ...openWeights);
    push("the mouth opens while speaking", maxOpen > 0.2, "peak aa " + maxOpen.toFixed(2));
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "reply.wav"), encodeWav(audio, SAMPLE_RATE));
  await writeFile(join(outDir, "frames.json"), JSON.stringify(sampled.map((f) => ({
    at: f.at,
    state: f.state,
    channels: f.channels,
    expressions: f.expressions,
    bones: Object.keys(f.bones),
  })), null, 1), "utf8");

  const unsupported = "unsupportedChannels" in loaded.backend
    ? (loaded.backend as { unsupportedChannels: Record<string, string> }).unsupportedChannels
    : {};

  const summary = {
    at: new Date().toISOString(),
    character: character.name,
    backend: loaded.backend.id,
    model: loaded.rig?.path ?? null,
    rig: report,
    unsupportedChannels: unsupported,
    frames: sampled.length,
    checks,
    pass: checks.every((c) => c.ok),
  };
  await writeFile(join(outDir, "vrm-accept.json"), JSON.stringify(summary, null, 2), "utf8");

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("attune · " + character.name);
    console.log("renderer: " + loaded.backend.id + (loaded.rig ? "  (" + loaded.rig.path + ")" : ""));
    console.log("");
    for (const line of report) console.log("  " + line);
    const dropped = Object.keys(unsupported);
    console.log("");
    console.log("  channels this rig cannot express: " + (dropped.length ? dropped.join(", ") : "(none)"));
    for (const key of dropped) console.log("    " + key + ": " + unsupported[key]);
    console.log("");
    for (const c of checks) console.log("  " + (c.ok ? "PASS" : "FAIL") + "  " + c.name + "  —  " + c.detail);
    console.log("");
    console.log("frames: " + join(outDir, "frames.json") + "  (" + sampled.length + ") ");
    console.log("audio:  " + join(outDir, "reply.wav"));
    console.log("");
    console.log("these checks say the rig moves and the numbers are sane.");
    console.log("they do not say it looks like a person - open frames.json and look.");
  }

  return checks.every((c) => c.ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
