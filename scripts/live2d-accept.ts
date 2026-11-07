/**
 * M5 acceptance: does the configured renderer actually move a 2D character?
 *
 * What this proves:
 *
 *   1. a .model3.json loads from [renderer] in character.toml, with no extra setup
 *   2. the model3 and its moc3 and textures are the files that were asked for
 *   3. the same gesture stream drives "none" and "live2d" to the same channel
 *      values - the claim of "one config, 2D or 3D" is not a VRM-only claim
 *   4. a nod moves ParamAngleY and then puts it back
 *   5. a blink closes the eyes and leaves them alone when nothing is blinking
 *   6. the mouth opens from the envelope, through the lip sync parameters the
 *      model asks for or the standard one it does not
 *   7. nothing outside those six families is written - a prop parameter moved
 *      from a conversation would be the engine inventing behaviour
 *   8. no frame contains NaN
 *
 * What it does not prove: that the character looks right on screen. Nothing in
 * a script can. The frames are written to disk; look at them.
 *
 *   node scripts/live2d-accept.ts --model <file.model3.json>
 *   node scripts/live2d-accept.ts --character <dir>
 *
 * The model lives outside this repository on purpose: the sample this backend
 * was written against is CC BY-NC-SA, and a MIT repository cannot carry it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadCharacter } from "../src/config.ts";
import { rendererFromConfig, describeLoadedRenderer } from "../src/render/load.ts";
import { backendFor } from "../src/render/factory.ts";
import { Stage } from "../src/render/stage.ts";
import { describeLive2D, lipSyncParameters } from "../src/render/live2d/model3.ts";
import { mouthFrames } from "../src/audio/envelope.ts";
import { encodeWav } from "../src/audio/wav.ts";
import type { Gesture } from "../src/render/gesture.ts";
import type { PoseFrame } from "../src/render/backend.ts";
import type { CharacterConfig } from "../src/types.ts";

const SAMPLE_RATE = 22050;
const FPS = 60;

/** The only parameter families a conversation is allowed to touch. */
const ALLOWED = ["ParamAngleY", "ParamAngleZ", "ParamEyeBallX", "ParamEyeBallY", "ParamBrowLY", "ParamBrowRY", "ParamEyeLOpen", "ParamEyeROpen", "ParamMouthOpenY"];

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function scriptedGestures(): Gesture[] {
  return [
    { channel: "nod", at: 200, peak: 0.6, riseMs: 120, holdMs: 90, fallMs: 200 },
    { channel: "head_tilt", at: 700, peak: 0.3, riseMs: 160, holdMs: 120, fallMs: 260 },
    { channel: "gaze_shift", at: 1100, peak: 0.4, riseMs: 220, holdMs: 320, fallMs: 260 },
    { channel: "brow_raise", at: 1500, peak: 0.3, riseMs: 90, holdMs: 160, fallMs: 220 },
    { channel: "blink", at: 1900, peak: 1, riseMs: 50, holdMs: 60, fallMs: 90 },
  ];
}

function tone(ms: number, hz: number, amp: number): Float32Array {
  const n = Math.round((ms / 1000) * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
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

function finite(frame: PoseFrame): boolean {
  for (const value of Object.values(frame.parameters)) {
    if (!Number.isFinite(value)) return false;
  }
  for (const value of Object.values(frame.channels)) {
    if (!Number.isFinite(value)) return false;
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
    console.error("usage: node scripts/live2d-accept.ts --model <file.model3.json> | --character <dir> [--out <dir>] [--json]");
    console.error("  --model      a .model3.json to drive directly");
    console.error("  --character  a character directory; its [renderer] decides");
    return 2;
  }

  let character: CharacterConfig;
  if (args.character) {
    character = await loadCharacter(args.character);
  } else {
    character = {
      name: "live2d-accept",
      personaPath: "",
      memoryNamespace: "live2d-accept",
      voice: { engine: "none", model: "none" },
      asr: { engine: "none", model: "none" },
      renderer: { type: "live2d", model: args.model as string },
      mapping: {},
      rootDir: process.cwd(),
    };
  }

  const outDir = args.out ?? join("out", "live2d-accept");
  const checks: Check[] = [];
  const push = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  let loaded;
  try {
    loaded = await rendererFromConfig(character);
  } catch (err) {
    console.error("renderer error: " + (err as Error).message);
    return 1;
  }

  const rig = loaded.rig?.kind === "live2d" ? loaded.rig.rig : null;
  const report = rig ? describeLive2D(rig) : ["(no model: the none backend has no rig to describe)" ];
  push("a renderer was built", loaded.backend.id === (rig ? "live2d" : "none"), "backend: " + loaded.backend.id);
  if (rig) {
    push("the model parsed as a model3", rig.spec === "model3", "moc3 " + rig.mocBytes + " bytes");
    push("it declares parameters", rig.parametersKnown, rig.parametersKnown ? rig.parameters.size + " in the cdi3" : "no DisplayInfo; standard names assumed");
    push("it has textures", rig.textures.length > 0, rig.textures.length + " texture(s)");
  }

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
    "none and live2d see the same channels",
    mismatch.length === 0,
    mismatch.length === 0 ? sampled.length + " frames agreed" : mismatch.slice(0, 3).join("; "),
  );

  push("no frame contains NaN", sampled.every(finite), sampled.length + " frames checked");

  if (rig) {
    // 1. The head turns during the nod and comes back.
    const nodding = sampled.filter((f) => f.at >= 200 && f.at <= 520);
    const nodValues = nodding.map((f) => f.parameters.ParamAngleY ?? 0);
    const nodPeak = Math.max(0, ...nodValues.map((v) => Math.abs(v)));
    push("the head moves during the nod", nodPeak > 0.5, "peak ParamAngleY " + nodPeak.toFixed(2) + " degrees");
    push("the nod is a nod, not a shudder", nodPeak > 2 && nodPeak < 20, "peak " + nodPeak.toFixed(2) + " degrees");

    const rest = sampled[sampled.length - 1];
    const restAngle = Math.abs(rest.parameters.ParamAngleY ?? 0) + Math.abs(rest.parameters.ParamAngleZ ?? 0);
    push("the head comes back to rest", restAngle < 0.5, restAngle.toFixed(3) + " degrees at the end");

    // 2. Blink closes the eyes, and does not pin them open at any other time.
    const blinkFrames = sampled.filter((f) => f.at >= 1900 && f.at <= 2100);
    const closed = Math.min(1, ...blinkFrames.map((f) => f.parameters.ParamEyeLOpen ?? 1));
    push("a blink closes the eyes", closed < 0.2, "lowest eye openness " + closed.toFixed(2));
    const idleFrames = sampled.filter((f) => f.at < 1800);
    const touchedWhileIdle = idleFrames.filter((f) => Object.prototype.hasOwnProperty.call(f.parameters, "ParamEyeLOpen"));
    push(
      "the eyes are left alone when nothing is blinking",
      touchedWhileIdle.length === 0,
      touchedWhileIdle.length === 0 ? "no idle frame writes eye openness" : touchedWhileIdle.length + " idle frames pinned the eyes",
    );

    // 3. The mouth opens from the envelope.
    const speaking = sampled.filter((f) => f.at > 600 && f.at < 1600);
    const mouthParam = lipSyncParameters(rig)[0];
    const maxOpen = Math.max(0, ...speaking.map((f) => f.parameters[mouthParam] ?? 0));
    push(
      "the mouth opens while speaking",
      maxOpen > 0.2,
      "peak " + mouthParam + " " + maxOpen.toFixed(2) + (rig.lipSyncIds.length ? "" : " (fell back: the model declares an empty LipSync group)"),
    );

    // 4. Nothing outside the allowed families. This is the invariant that keeps
    //    a conversation from animating a prop or a costume switch.
    const written = new Set<string>();
    for (const frame of sampled) for (const id of Object.keys(frame.parameters)) written.add(id);
    const stray = [...written].filter((id) => !ALLOWED.includes(id));
    push("only conversation parameters are written", stray.length === 0, stray.length ? stray.join(", ") : written.size + " parameter(s), all allowed");
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "reply.wav"), encodeWav(audio, SAMPLE_RATE));
  await writeFile(
    join(outDir, "frames.json"),
    JSON.stringify(
      sampled.map((f) => ({ at: f.at, state: f.state, channels: f.channels, parameters: f.parameters, assumed: f.parametersAssumed })),
      null,
      1,
    ),
    "utf8",
  );

  const unsupported = "unsupportedChannels" in loaded.backend
    ? (loaded.backend as { unsupportedChannels: Record<string, string> }).unsupportedChannels
    : {};

  const summary = {
    at: new Date().toISOString(),
    character: character.name,
    backend: loaded.backend.id,
    model: loaded.modelPath,
    rig: report,
    summary: describeLoadedRenderer(loaded),
    unsupportedChannels: unsupported,
    frames: sampled.length,
    checks,
    pass: checks.every((c) => c.ok),
  };
  await writeFile(join(outDir, "live2d-accept.json"), JSON.stringify(summary, null, 2), "utf8");

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("attune · " + character.name);
    console.log("renderer: " + loaded.backend.id + (loaded.modelPath ? "  (" + loaded.modelPath + ")" : ""));
    console.log("");
    for (const line of report) console.log("  " + line);
    const dropped = Object.keys(unsupported);
    console.log("");
    console.log("  channels this rig cannot express: " + (dropped.length ? dropped.join(", ") : "(none)"));
    for (const key of dropped) console.log("    " + key + ": " + unsupported[key]);
    console.log("");
    for (const c of checks) console.log("  " + (c.ok ? "PASS" : "FAIL") + "  " + c.name + "  —  " + c.detail);
    console.log("");
    console.log("frames: " + join(outDir, "frames.json") + "  (" + sampled.length + ")");
    console.log("audio:  " + join(outDir, "reply.wav"));
    console.log("");
    console.log("these checks say the parameter values are sane and the right ones moved.");
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
