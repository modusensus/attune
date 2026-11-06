import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.ts";
import { MemoryStore } from "../src/memory.ts";
import type { CharacterConfig, EngineEvent, Message } from "../src/types.ts";
import type { Provider } from "../src/provider.ts";

/** A provider that records what it was asked and replays scripted deltas. */
class ScriptedProvider implements Provider {
  readonly id = "scripted";
  seen: Message[][] = [];
  private readonly chunks: string[];
  private readonly failWith?: Error;

  constructor(chunks: string[], failWith?: Error) {
    this.chunks = chunks;
    this.failWith = failWith;
  }

  async *stream(messages: Message[]): AsyncIterable<string> {
    this.seen.push(messages);
    if (this.failWith) throw this.failWith;
    for (const chunk of this.chunks) yield chunk;
  }
}

async function setup(chunks: string[], failWith?: Error) {
  const dir = await mkdtemp(join(tmpdir(), "attune-eng-"));
  const personaPath = join(dir, "persona.md");
  await writeFile(personaPath, "你是小满。", "utf8");
  const character: CharacterConfig = {
    name: "小满",
    personaPath,
    memoryNamespace: "example",
    voice: { engine: "none", model: "none" },
    renderer: { type: "none", model: "none" },
    mapping: {},
    rootDir: dir,
  };
  const provider = new ScriptedProvider(chunks, failWith);
  const engine = new Engine({ character, provider, stateDir: dir });
  return { dir, engine, provider, character, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function collect(iter: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

test("a turn emits state transitions, deltas and a final reply", async () => {
  const s = await setup(["嗯", "，", "今晚没人。"]);
  try {
    const events = await collect(s.engine.turn("今晚有人来吗"));
    const states = events.filter((e) => e.type === "state").map((e) => (e as { state: string }).state);
    assert.deepEqual(states, ["listening", "thinking", "speaking", "listening"]);
    const reply = events.find((e) => e.type === "reply") as { text: string };
    assert.equal(reply.text, "嗯，今晚没人。");
    const deltas = events.filter((e) => e.type === "delta");
    assert.equal(deltas.length, 3);
  } finally {
    await s.cleanup();
  }
});

test("both sides of the turn are persisted", async () => {
  const s = await setup(["在。"]);
  try {
    await collect(s.engine.turn("在吗"));
    const store = new MemoryStore(s.dir, "example");
    const turns = await store.load();
    assert.equal(turns.length, 2);
    assert.equal(turns[0].role, "user");
    assert.equal(turns[0].content, "在吗");
    assert.equal(turns[1].role, "assistant");
    assert.equal(turns[1].content, "在。");
  } finally {
    await s.cleanup();
  }
});

test("history is replayed to the provider on the second turn", async () => {
  const s = await setup(["嗯。"]);
  try {
    await collect(s.engine.turn("第一句"));
    await collect(s.engine.turn("第二句"));
    const second = s.provider.seen[1];
    const contents = second.map((m) => m.content);
    assert.ok(contents[0].includes("你是小满。"));
    assert.ok(contents.some((c) => c === "第一句"));
    assert.ok(contents.some((c) => c === "嗯。"));
    assert.equal(second[second.length - 1].content, "第二句");
  } finally {
    await s.cleanup();
  }
});

test("history is capped so the prompt cannot grow without bound", async () => {
  const s = await setup(["好。"]);
  try {
    for (let i = 0; i < 8; i++) await collect(s.engine.turn("第" + i + "句"));
    const last = s.provider.seen[s.provider.seen.length - 1];
    const historyMessages = last.slice(1, -1);
    assert.ok(historyMessages.length <= 12, "history messages: " + historyMessages.length);
    assert.equal(last[last.length - 1].content, "第7句");
  } finally {
    await s.cleanup();
  }
});

test("an empty utterance is rejected before any write", async () => {
  const s = await setup(["x"]);
  try {
    await assert.rejects(() => collect(s.engine.turn("   ")), /empty utterance/);
    assert.deepEqual(await new MemoryStore(s.dir, "example").load(), []);
  } finally {
    await s.cleanup();
  }
});

test("a provider failure surfaces and leaves no half-turn behind", async () => {
  const s = await setup([], new Error("endpoint refused"));
  try {
    await assert.rejects(() => collect(s.engine.turn("在吗")), /endpoint refused/);
    const turns = await new MemoryStore(s.dir, "example").load();
    assert.deepEqual(turns.map((t) => t.role), ["user"]);
  } finally {
    await s.cleanup();
  }
});

test("an empty reply is an error rather than a silent assistant turn", async () => {
  const s = await setup(["   "]);
  try {
    await assert.rejects(() => collect(s.engine.turn("在吗")), /empty reply/);
  } finally {
    await s.cleanup();
  }
});

test("the persona is read once and reused across turns", async () => {
  const s = await setup(["嗯。"]);
  try {
    await collect(s.engine.turn("a"));
    await rm(s.character.personaPath);
    // Would throw ENOENT if the card were re-read per turn.
    const events = await collect(s.engine.turn("b"));
    assert.ok(events.some((e) => e.type === "reply"));
  } finally {
    await s.cleanup();
  }
});
