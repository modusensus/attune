import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToml } from "../src/toml.ts";

test("parses tables, scalars and arrays", () => {
  const t = parseToml([
    "[identity]",
    'name = "小满"',
    'persona = "persona.md"',
    "count = 3",
    "ratio = 0.6",
    "on = true",
    'tags = ["a", "b"]',
  ].join("\n"));
  const identity = t.identity as Record<string, unknown>;
  assert.equal(identity.name, "小满");
  assert.equal(identity.persona, "persona.md");
  assert.equal(identity.count, 3);
  assert.equal(identity.ratio, 0.6);
  assert.equal(identity.on, true);
  assert.deepEqual(identity.tags, ["a", "b"]);
});

test("strips comments but keeps hashes inside strings", () => {
  const t = parseToml('note = "a # b" # trailing\n[x]\nk = 1 # nope');
  assert.equal(t.note, "a # b");
  assert.equal((t.x as Record<string, unknown>).k, 1);
});

test("supports nested table headers", () => {
  const t = parseToml("[a.b]\nk = 1\n[a.c]\nj = 2");
  const a = t.a as Record<string, Record<string, unknown>>;
  assert.equal(a.b.k, 1);
  assert.equal(a.c.j, 2);
});

test("rejects unsupported syntax loudly", () => {
  assert.throws(() => parseToml("a = bare"), /unsupported value/);
  assert.throws(() => parseToml("[[items]]"), /array-of-tables/);
  assert.throws(() => parseToml("a.b = 1"), /dotted keys/);
  assert.throws(() => parseToml("[a]\n[a]\nk = 1"), /declared twice/);
  assert.throws(() => parseToml("[a.b]\n[a.b]"), /declared twice/);
  // Redefining a parent table under a child header is legal TOML, not an error.
  assert.doesNotThrow(() => parseToml("[a]\n[a.b]\nk = 1"));
});
