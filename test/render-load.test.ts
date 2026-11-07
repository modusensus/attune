import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCharacter } from "../src/config.ts";
import { rendererFromConfig } from "../src/render/load.ts";
import { backendFor, rendererNeedsModel } from "../src/render/factory.ts";
import { RendererError } from "../src/render/backend.ts";
import { buildGlb, vrm10, plainGlb } from "./fixtures/vrm-build.ts";

async function character(files: Record<string, string>): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "attune-render-"));
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const toml = (lines: string[]) =>
  ["[identity]", "name = \"小满\"", "persona = \"persona.md\"", "[renderer]", ...lines].join("\n");

test("none needs no model and answers with the null backend", async () => {
  const c = await character({ "character.toml": toml(["type = \"none\""]), "persona.md": "x" });
  try {
    const loaded = await rendererFromConfig(await loadCharacter(c.dir));
    assert.equal(loaded.backend.id, "none");
    assert.equal(loaded.rig, null);
  } finally {
    await c.cleanup();
  }
});

test("a vrm character loads its model and the rig comes back with it", async () => {
  const c = await character({ "character.toml": toml(["type = \"vrm\"", "model = \"model.vrm\""]), "persona.md": "x" });
  try {
    await writeFile(join(c.dir, "model.vrm"), buildGlb({ json: vrm10({ eyes: true }) }));
    const loaded = await rendererFromConfig(await loadCharacter(c.dir));
    assert.equal(loaded.backend.id, "vrm");
    assert.ok(loaded.rig);
    assert.equal(loaded.rig.rig.spec, "1.0");
    assert.match(loaded.rig.path, /model\.vrm$/);
  } finally {
    await c.cleanup();
  }
});

test("vrm without a model complains about the config, not about a file", async () => {
  const c = await character({ "character.toml": toml(["type = \"vrm\""]), "persona.md": "x" });
  try {
    const cfg = await loadCharacter(c.dir);
    await assert.rejects(() => rendererFromConfig(cfg), (err: Error) => {
      assert.ok(err instanceof RendererError);
      assert.match(err.message, /renderer type "vrm" needs a model/);
      assert.doesNotMatch(err.message, /model file not found/, "a missing setting is not a missing file");
      return true;
    });
  } finally {
    await c.cleanup();
  }
});

test("a model path that does not exist names the path it looked for", async () => {
  const c = await character({ "character.toml": toml(["type = \"vrm\"", "model = \"missing.vrm\""]), "persona.md": "x" });
  try {
    const cfg = await loadCharacter(c.dir);
    await assert.rejects(() => rendererFromConfig(cfg), (err: Error) => {
      assert.ok(err instanceof RendererError);
      assert.match(err.message, /^renderer: model file not found: .*missing\.vrm$/);
      return true;
    });
  } finally {
    await c.cleanup();
  }
});

test("a file that is not a VRM is rejected with the parser reason attached", async () => {
  const c = await character({ "character.toml": toml(["type = \"vrm\"", "model = \"model.vrm\""]), "persona.md": "x" });
  try {
    await writeFile(join(c.dir, "model.vrm"), buildGlb({ json: plainGlb() }));
    const cfg = await loadCharacter(c.dir);
    await assert.rejects(() => rendererFromConfig(cfg), (err: Error) => {
      assert.ok(err instanceof RendererError);
      assert.match(err.message, /^renderer: .*has no VRM extension/);
      return true;
    });
  } finally {
    await c.cleanup();
  }
});

test("an empty model file says it is empty", async () => {
  const c = await character({ "character.toml": toml(["type = \"vrm\"", "model = \"model.vrm\""]), "persona.md": "x" });
  try {
    await writeFile(join(c.dir, "model.vrm"), "");
    const cfg = await loadCharacter(c.dir);
    await assert.rejects(() => rendererFromConfig(cfg), (err: Error) => {
      assert.match(err.message, /model file is empty: .*model\.vrm$/);
      return true;
    });
  } finally {
    await c.cleanup();
  }
});

test("live2d is refused by name rather than silently substituted", async () => {
  const c = await character({ "character.toml": toml(["type = \"live2d\""]), "persona.md": "x" });
  try {
    const cfg = await loadCharacter(c.dir);
    await assert.rejects(() => rendererFromConfig(cfg), (err: Error) => {
      assert.ok(err instanceof RendererError);
      assert.match(err.message, /renderer type "live2d" is not implemented yet/);
      return true;
    });
  } finally {
    await c.cleanup();
  }
});

test("a typo in the renderer type is refused and lists what is valid", () => {
  assert.throws(() => backendFor("vrnn"), (err: Error) => {
    assert.ok(err instanceof RendererError);
    assert.match(err.message, /unknown renderer type: "vrnn" \(expected none, vrm, or live2d\)/);
    return true;
  });
});

test("the type is trimmed and case-folded, and empty means none", () => {
  assert.equal(backendFor("").id, "none");
  assert.equal(backendFor("  NoNe ").id, "none");
  assert.throws(() => backendFor("  VRM "), /needs a model/);
});

test("rendererNeedsModel only says yes for vrm", () => {
  assert.equal(rendererNeedsModel("none"), false);
  assert.equal(rendererNeedsModel(""), false);
  assert.equal(rendererNeedsModel("vrm"), true);
  assert.equal(rendererNeedsModel(" VRM "), true);
  assert.equal(rendererNeedsModel("live2d"), false, "live2d would need one, but it is refused before any file is touched");
});
