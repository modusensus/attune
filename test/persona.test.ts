import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMessages, buildSystemPrompt, loadPersona } from "../src/persona.ts";
import type { Turn } from "../src/types.ts";

/** Relative, not absolute: a fixture path pinned to one developer's disk is a test that only runs on one disk. */
const HERE = dirname(fileURLToPath(import.meta.url));

const persona = "你是小满，一个在旧书店上夜班的人。";
const history: Turn[] = [
  { role: "user", content: "在吗", at: "t1" },
  { role: "assistant", content: "嗯。", at: "t2" },
];

test("system prompt carries the frame, the card and the history", () => {
  const prompt = buildSystemPrompt(persona, history);
  assert.match(prompt, /live conversation/);
  assert.match(prompt, /# Persona card/);
  assert.ok(prompt.includes(persona));
  assert.match(prompt, /User: 在吗/);
  assert.match(prompt, /You: 嗯。/);
});

test("no history means no empty history section", () => {
  const prompt = buildSystemPrompt(persona, []);
  assert.ok(!prompt.includes("# Earlier in this conversation"));
});

test("messages replay history before the new utterance", async () => {
  const messages = await buildMessages(
    { name: "x", personaPath: "p", memoryNamespace: "x", voice: { engine: "none", model: "none" }, renderer: { type: "none", model: "none" }, mapping: {}, rootDir: "." },
    persona,
    history,
    "今晚有人来吗",
  );
  assert.equal(messages.length, 4);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].content, "在吗");
  assert.equal(messages[3].role, "user");
  assert.equal(messages[3].content, "今晚有人来吗");
});

test("an empty persona card is an error, not a silent empty prompt", async () => {
  await assert.rejects(() => loadPersona(join(HERE, "fixtures", "empty-persona.md")), /persona card is empty/);
});
