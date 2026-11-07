import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeLive2D,
  lipSyncParameters,
  Live2DError,
  loadLive2DModel,
  parseModel3,
  type Live2DRig,
} from "../src/render/live2d/model3.ts";
import { Live2DBackend } from "../src/render/live2d/backend.ts";
import { rendererFromConfig } from "../src/render/load.ts";
import { loadCharacter } from "../src/config.ts";
import type { Gesture } from "../src/render/gesture.ts";

/** A model3.json with everything this backend reads. */
function model3(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Version: 3,
    FileReferences: {
      Moc: "c.moc3",
      Textures: ["c.2048/texture_00.png", "c.2048/texture_01.png"],
      Physics: "c.physics3.json",
      DisplayInfo: "c.cdi3.json",
      Motions: {
        idle: [{ File: "motions/idle.motion3.json", FadeInTime: 0.5, FadeOutTime: 0.7 }],
      },
    },
    Groups: [
      { Target: "Parameter", Name: "EyeBlink", Ids: ["ParamEyeLOpen", "ParamEyeROpen"] },
      { Target: "Parameter", Name: "LipSync", Ids: [] },
    ],
    HitAreas: [{ Name: "Head" }, { Name: "Body" }],
    ...over,
  });
}

/** The parameter ids the standard Cubism set gives us, as a cdi3 would list them. */
const STANDARD = [
  "ParamAngleX",
  "ParamAngleY",
  "ParamAngleZ",
  "ParamEyeBallX",
  "ParamEyeBallY",
  "ParamBrowLY",
  "ParamBrowRY",
  "ParamEyeLOpen",
  "ParamEyeROpen",
  "ParamMouthOpenY",
  "ParamMouthForm",
  "ParamBodyAngleX",
];

function cdi3(ids: string[] = STANDARD): string {
  return JSON.stringify({
    Version: 3,
    Parameters: ids.map((id) => ({ Id: id, Name: "name of " + id, GroupId: "" })),
  });
}

async function model(files: Record<string, string | Buffer>): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "attune-live2d-"));
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A file that starts with the Cubism magic and has filler after it. */
function moc3(size = 64): Buffer {
  const buf = Buffer.alloc(size, 0);
  buf.write("MOC3", 0, "latin1");
  return buf;
}

function gesture(channel: string, peak: number, at = 100, span = 200): Gesture {
  return { channel, at, peak, riseMs: span / 2, holdMs: 0, fallMs: span / 2 };
}

function frameAt(backend: Live2DBackend, gestures: Gesture[], at: number, mouth = 0) {
  return backend.frame({ state: "listening", at, gestures, mouth });
}

// --- parsing -------------------------------------------------------------

test("parseModel3 reads the references this backend depends on", () => {
  const spec = parseModel3(model3(), "m.model3.json");
  assert.equal(spec.moc, "c.moc3");
  assert.deepEqual(spec.textures, ["c.2048/texture_00.png", "c.2048/texture_01.png"]);
  assert.equal(spec.physics, "c.physics3.json");
  assert.equal(spec.displayInfo, "c.cdi3.json");
  assert.deepEqual(spec.eyeBlinkIds, ["ParamEyeLOpen", "ParamEyeROpen"]);
  assert.deepEqual(spec.lipSyncIds, []);
  assert.equal(spec.motions.idle.length, 1);
  assert.equal(spec.motions.idle[0].fadeIn, 0.5);
  assert.deepEqual(spec.hitAreas, ["Head", "Body"]);
});

test("parseModel3 names the file it could not read", () => {
  assert.throws(() => parseModel3("{", "x.model3.json"), (err: Error) => {
    assert.ok(err instanceof Live2DError);
    assert.match(err.message, /^x\.model3\.json: not valid JSON/);
    return true;
  });
  assert.throws(() => parseModel3("[]", "x.model3.json"), /must be a JSON object/);
  assert.throws(() => parseModel3("{}", "x.model3.json"), /has no FileReferences/);
  assert.throws(() => parseModel3('{"FileReferences":{}}', "x.model3.json"), /FileReferences\.Moc is missing/);
});

test("a model with no optional sections still parses", () => {
  const spec = parseModel3('{"FileReferences":{"Moc":"c.moc3"}}', "m");
  assert.deepEqual(spec.textures, []);
  assert.equal(spec.physics, null);
  assert.equal(spec.displayInfo, null);
  assert.deepEqual(spec.eyeBlinkIds, []);
  assert.deepEqual(Object.keys(spec.motions), []);
  assert.deepEqual(spec.expressions, []);
});

test("an empty LipSync group falls back to the standard mouth parameter", () => {
  // This is the whale girl model exactly: the group is declared and empty.
  const rig = { lipSyncIds: [] } as unknown as Live2DRig;
  assert.deepEqual(lipSyncParameters(rig), ["ParamMouthOpenY"]);
  const declared = { lipSyncIds: ["ParamMouthOpenY", "ParamJawOpen"] } as unknown as Live2DRig;
  assert.deepEqual(lipSyncParameters(declared), ["ParamMouthOpenY", "ParamJawOpen"]);
});

// --- loading from disk ---------------------------------------------------

test("loadLive2DModel resolves the moc3 and textures next to the model file", async () => {
  const m = await model({
    "c_0120.model3.json": model3(),
    "c.moc3": moc3(4096),
    "c.cdi3.json": cdi3(),
    "c.physics3.json": "{}",
    "c.2048/texture_00.png": "x",
    "c.2048/texture_01.png": "y",
    "motions/idle.motion3.json": "{}",
  });
  try {
    const rig = await loadLive2DModel(join(m.dir, "c_0120.model3.json"));
    assert.equal(rig.spec, "model3");
    assert.equal(rig.mocBytes, 4096);
    assert.equal(rig.parametersKnown, true);
    assert.equal(rig.parameters.size, STANDARD.length);
    assert.equal(rig.parameters.get("ParamAngleY")?.name, "name of ParamAngleY");
    assert.equal(rig.textures.length, 2);
    assert.match(rig.textures[0], /c\.2048[\\/]texture_00\.png$/);
    assert.match(rig.motions.idle[0].file, /motions[\\/]idle\.motion3\.json$/);
  } finally {
    await m.cleanup();
  }
});

test("a missing model names the absolute path it looked for", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attune-live2d-"));
  try {
    await assert.rejects(() => loadLive2DModel(join(dir, "nope.model3.json")), (err: Error) => {
      assert.ok(err instanceof Live2DError);
      assert.match(err.message, /model file not found: .*nope\.model3\.json$/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the moc3 is checked for magic and size, and the reason is specific", async () => {
  const cases: Array<[string, Buffer | null, RegExp]> = [
    ["missing", null, /moc3 file not found:/],
    ["empty", Buffer.alloc(0), /moc3 file is empty:/],
    ["short", Buffer.from("MO", "latin1"), /moc3 file is truncated:/],
    ["wrong magic", Buffer.from("NOPE0000", "latin1"), /not a Cubism moc3 \(magic was "NOPE"\):/],
  ];
  for (const [label, bytes, expected] of cases) {
    const m = await model({ "c_0120.model3.json": model3(), "c.cdi3.json": cdi3() });
    try {
      if (bytes) await writeFile(join(m.dir, "c.moc3"), bytes);
      await assert.rejects(() => loadLive2DModel(join(m.dir, "c_0120.model3.json")), (err: Error) => {
        assert.ok(err instanceof Live2DError, label);
        assert.match(err.message, expected, label);
        return true;
      });
    } finally {
      await m.cleanup();
    }
  }
});

test("a model with no DisplayInfo loads and says the parameters are unknown", async () => {
  const m = await model({
    "c_0120.model3.json": JSON.stringify({ FileReferences: { Moc: "c.moc3" } }),
    "c.moc3": moc3(),
  });
  try {
    const rig = await loadLive2DModel(join(m.dir, "c_0120.model3.json"));
    assert.equal(rig.parametersKnown, false);
    assert.equal(rig.parameters.size, 0);
    const text = describeLive2D(rig).join("\n");
    assert.match(text, /not declared \(no DisplayInfo; standard names assumed\)/);
  } finally {
    await m.cleanup();
  }
});

test("a declared-but-missing DisplayInfo is an error, not a silent downgrade", async () => {
  const m = await model({ "c_0120.model3.json": model3(), "c.moc3": moc3() });
  try {
    await assert.rejects(() => loadLive2DModel(join(m.dir, "c_0120.model3.json")), /display info not found:/);
  } finally {
    await m.cleanup();
  }
});

test("describeLive2D reports what a person would check", async () => {
  const m = await model({
    "c_0120.model3.json": model3(),
    "c.moc3": moc3(2048),
    "c.cdi3.json": cdi3(["ParamAngleY"]),
    "c.physics3.json": "{}",
    "c.2048/texture_00.png": "x",
    "c.2048/texture_01.png": "y",
    "motions/idle.motion3.json": "{}",
  });
  try {
    const rig = await loadLive2DModel(join(m.dir, "c_0120.model3.json"));
    const text = describeLive2D(rig).join("\n");
    assert.match(text, /1 declared/);
    assert.match(text, /textures: 2 file\(s\)/);
    assert.match(text, /group declared empty; falling back to ParamMouthOpenY/);
    assert.match(text, /motions:  1 group\(s\): idle/);
  } finally {
    await m.cleanup();
  }
});

// --- the backend ---------------------------------------------------------

function backendForRig(over: { known?: boolean; ids?: string[]; lip?: string[] } = {}): Live2DBackend {
  const ids = over.ids ?? STANDARD;
  const rig: Live2DRig = {
    spec: "model3",
    modelPath: "m",
    mocPath: "c",
    mocBytes: 1,
    textures: [],
    physics: null,
    displayInfo: null,
    parameters: new Map(ids.map((id) => [id, { id, name: id, group: "" }])),
    parametersKnown: over.known ?? true,
    eyeBlinkIds: ["ParamEyeLOpen", "ParamEyeROpen"],
    lipSyncIds: over.lip ?? [],
    motions: {},
    expressions: [],
    hitAreas: [],
  };
  return new Live2DBackend(rig);
}

test("a nod turns the head down and a tilt leans it, with Cubism signs", () => {
  const backend = backendForRig();
  // Cubism: +ParamAngleY is chin up, so a nod is negative.
  const nod = frameAt(backend, [gesture("nod", 1, 0, 200)], 100);
  assert.ok(nod.parameters.ParamAngleY < 0, "a nod must be negative ParamAngleY");
  assert.equal(nod.parameters.ParamAngleY, -12);

  const tilt = frameAt(backend, [gesture("head_tilt", 1, 0, 200)], 100);
  assert.equal(tilt.parameters.ParamAngleZ, -9);
  assert.equal(tilt.parameters.ParamAngleY, undefined, "a tilt is not a nod");
});

test("gaze moves the eye balls, not the head", () => {
  const backend = backendForRig();
  const frame = frameAt(backend, [gesture("gaze_shift", 1, 0, 200)], 100);
  assert.equal(frame.parameters.ParamEyeBallX, 0.8);
  assert.ok((frame.parameters.ParamEyeBallY ?? 0) > 0);
  assert.equal(frame.parameters.ParamAngleY, undefined);
});

test("brows rise together and use the model's own parameter names", () => {
  const backend = backendForRig();
  const frame = frameAt(backend, [gesture("brow_raise", 1, 0, 200)], 100);
  assert.equal(frame.parameters.ParamBrowLY, 0.8);
  assert.equal(frame.parameters.ParamBrowRY, 0.8);
});

test("a blink closes both eyes, and no blink leaves them untouched", () => {
  const backend = backendForRig();
  const blinking = frameAt(backend, [gesture("blink", 1, 0, 200)], 100);
  assert.equal(blinking.parameters.ParamEyeLOpen, 0);
  assert.equal(blinking.parameters.ParamEyeROpen, 0);

  // Writing 1 here would cancel the model's own blink motion, so idle frames
  // must not mention the parameter at all.
  const idle = frameAt(backend, [], 100);
  assert.equal(idle.parameters.ParamEyeLOpen, undefined);
  assert.equal(Object.keys(idle.parameters).length, 0);
});

test("the mouth goes through the model's lip sync parameters when declared", () => {
  const backend = backendForRig({ lip: ["ParamMouthOpenY", "ParamJawOpen"], ids: [...STANDARD, "ParamJawOpen"] });
  const frame = frameAt(backend, [], 100, 0.7);
  assert.equal(frame.parameters.ParamMouthOpenY, 0.7);
  assert.equal(frame.parameters.ParamJawOpen, 0.7);
});

test("a parameter the model does not have is dropped with a reason", () => {
  const backend = backendForRig({ ids: ["ParamAngleY"] });
  const frame = frameAt(backend, [gesture("head_tilt", 1, 0, 200), gesture("brow_raise", 1, 0, 200)], 100);
  assert.equal(frame.parameters.ParamAngleZ, undefined);
  assert.ok(frame.dropped.some((d) => /head_tilt: model has no parameter ParamAngleZ/.test(d)), frame.dropped.join("; "));
  assert.ok(frame.dropped.some((d) => /brow_raise: model has no parameter ParamBrowLY/.test(d)), frame.dropped.join("; "));
});

test("without a DisplayInfo the values are written and the frame admits it", () => {
  const backend = backendForRig({ known: false });
  const frame = frameAt(backend, [gesture("nod", 1, 0, 200)], 100);
  assert.equal(frame.parameters.ParamAngleY, -12);
  assert.equal(frame.parametersAssumed, true);
  assert.deepEqual(frame.dropped, []);
});

test("a model that declares its parameters gets an honest unsupported list", () => {
  assert.deepEqual(backendForRig().unsupportedChannels, {});
  const partial = backendForRig({ ids: ["ParamAngleY"] });
  assert.match(partial.unsupportedChannels.head_tilt, /no ParamAngleZ/);
  assert.match(partial.unsupportedChannels.gaze_shift, /no ParamEyeBallX/);
  assert.match(partial.unsupportedChannels.mouth, /no ParamMouthOpenY/);
  // Nothing is known about a model with no DisplayInfo, so nothing is claimed.
  assert.deepEqual(backendForRig({ known: false }).unsupportedChannels, {});
});

test("the backend never writes outside the conversation parameter families", () => {
  // A prop parameter moved by a conversation is the engine inventing behaviour.
  const backend = backendForRig();
  const at = frameAt(
    backend,
    [
      gesture("nod", 1, 0, 200),
      gesture("head_tilt", 1, 0, 200),
      gesture("gaze_shift", 1, 0, 200),
      gesture("brow_raise", 1, 0, 200),
      gesture("blink", 1, 0, 200),
    ],
    100,
    1,
  );
  const allowed = new Set([
    "ParamAngleY",
    "ParamAngleZ",
    "ParamEyeBallX",
    "ParamEyeBallY",
    "ParamBrowLY",
    "ParamBrowRY",
    "ParamEyeLOpen",
    "ParamEyeROpen",
    "ParamMouthOpenY",
  ]);
  for (const id of Object.keys(at.parameters)) assert.ok(allowed.has(id), "stray parameter " + id);
});

test("an unknown channel produces no parameters at all", () => {
  const backend = backendForRig();
  const frame = frameAt(backend, [gesture("something_new", 1, 0, 200)], 100);
  assert.deepEqual(frame.parameters, {});
});

// --- through the config --------------------------------------------------

test("a live2d character loads its model3 and the rig comes back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attune-live2d-cfg-"));
  try {
    await writeFile(
      join(dir, "character.toml"),
      ["[identity]", 'name = "小满"', 'persona = "persona.md"', "[renderer]", 'type = "live2d"', 'model = "w/c_0120.model3.json"'].join("\n"),
      "utf8",
    );
    await writeFile(join(dir, "persona.md"), "x", "utf8");
    await mkdir(join(dir, "w"), { recursive: true });
    await writeFile(join(dir, "w", "c_0120.model3.json"), model3(), "utf8");
    await writeFile(join(dir, "w", "c.moc3"), moc3(), "utf8");
    await writeFile(join(dir, "w", "c.cdi3.json"), cdi3(), "utf8");
    await writeFile(join(dir, "w", "c.physics3.json"), "{}", "utf8");
    await mkdir(join(dir, "w", "c.2048"), { recursive: true });
    await writeFile(join(dir, "w", "c.2048", "texture_00.png"), "x", "utf8");
    await writeFile(join(dir, "w", "c.2048", "texture_01.png"), "y", "utf8");
    await mkdir(join(dir, "w", "motions"), { recursive: true });
    await writeFile(join(dir, "w", "motions", "idle.motion3.json"), "{}", "utf8");

    const loaded = await rendererFromConfig(await loadCharacter(dir));
    assert.equal(loaded.backend.id, "live2d");
    assert.equal(loaded.rig?.kind, "live2d");
    assert.match(loaded.modelPath ?? "", /c_0120\.model3\.json$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a broken model3 in a live2d character becomes a renderer error with the path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attune-live2d-cfg-"));
  try {
    await writeFile(
      join(dir, "character.toml"),
      ["[identity]", 'name = "x"', 'persona = "persona.md"', "[renderer]", 'type = "live2d"', 'model = "bad.model3.json"'].join("\n"),
      "utf8",
    );
    await writeFile(join(dir, "persona.md"), "x", "utf8");
    await writeFile(join(dir, "bad.model3.json"), "{ nope", "utf8");
    await assert.rejects(() => loadCharacter(dir).then(rendererFromConfig), (err: Error) => {
      assert.match(err.message, /renderer: .*bad\.model3\.json: not valid JSON/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
