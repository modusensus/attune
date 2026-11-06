import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCharacter, ConfigError } from "../src/config.ts";

async function character(files: Record<string, string>): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "attune-cfg-"));
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const MINIMAL = [
  "[identity]",
  'name = "小满"',
  'persona = "persona.md"',
].join("\n");

test("loads a minimal character and defaults the optional tables", async () => {
  const c = await character({ "character.toml": MINIMAL, "persona.md": "你在旧书店上夜班。" });
  try {
    const cfg = await loadCharacter(c.dir);
    assert.equal(cfg.name, "小满");
    assert.equal(cfg.memoryNamespace, "小满");
    assert.equal(cfg.voice.engine, "none");
    assert.equal(cfg.renderer.type, "none");
    assert.deepEqual(cfg.mapping, {});
    assert.match(cfg.personaPath, /persona\.md$/);
  } finally {
    await c.cleanup();
  }
});

test("keeps the declared namespace, voice, renderer and mapping", async () => {
  const toml = [
    MINIMAL,
    'memory_namespace = "example"',
    "[voice]",
    'engine = "gpt-sovits"',
    'model = "voice.pth"',
    "[renderer]",
    'type = "vrm"',
    'model = "model.vrm"',
    "[mapping]",
    "backchannel_nod = 0.6",
    "turn_take_blink = true",
  ].join("\n");
  const c = await character({ "character.toml": toml, "persona.md": "x" });
  try {
    const cfg = await loadCharacter(c.dir);
    assert.equal(cfg.memoryNamespace, "example");
    assert.equal(cfg.voice.engine, "gpt-sovits");
    assert.equal(cfg.renderer.type, "vrm");
    assert.deepEqual(cfg.mapping, { backchannel_nod: 0.6, turn_take_blink: true });
  } finally {
    await c.cleanup();
  }
});

test("fails with a readable message when required pieces are missing", async () => {
  const noFile = await character({});
  const noPersona = await character({ "character.toml": MINIMAL });
  const noName = await character({ "character.toml": "[identity]\npersona = \"p.md\"", "persona.md": "x" });
  try {
    await assert.rejects(() => loadCharacter(noFile.dir), (err: unknown) =>
      err instanceof ConfigError && /no character\.toml/.test(err.message));
    await assert.rejects(() => loadCharacter(noPersona.dir), (err: unknown) =>
      err instanceof ConfigError && /persona file not found/.test(err.message));
    await assert.rejects(() => loadCharacter(noName.dir), (err: unknown) =>
      err instanceof ConfigError && /missing name/.test(err.message));
  } finally {
    await Promise.all([noFile.cleanup(), noPersona.cleanup(), noName.cleanup()]);
  }
});

test("rejects a mapping value that is a nested table", async () => {
  const c = await character({
    "character.toml": MINIMAL + "\n[mapping.nod]\nx = 1",
    "persona.md": "x",
  });
  try {
    await assert.rejects(() => loadCharacter(c.dir), /must be a scalar or a flat array/);
  } finally {
    await c.cleanup();
  }
});
