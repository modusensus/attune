import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.ts";
import { MemoryStore } from "../src/memory.ts";
import type { CharacterConfig, EngineEvent, Message } from "../src/types.ts";
import type { Provider } from "../src/provider.ts";
import { SilentSpeech, type SpeechClip, type SpeechProvider } from "../src/speech.ts";

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
/** A speech engine that returns fixed, known audio without touching the system. */
class StubSpeech implements SpeechProvider {
  readonly id = "stub";
  calls: string[] = [];
  private readonly failWith?: Error;

  constructor(failWith?: Error) {
    this.failWith = failWith;
  }

  async speak(text: string): Promise<SpeechClip> {
    this.calls.push(text);
    if (this.failWith) throw this.failWith;
    const rate = 8000;
    const n = rate / 2; // 500ms
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * 220 * i) / rate) * 0.6;
    return {
      engine: this.id,
      text,
      audio: { sampleRate: rate, channels: 1, bitsPerSample: 16, format: 1, samples, durationMs: 500 },
    };
  }
}

async function setupVoice(chunks: string[], speech: SpeechProvider) {
  const base = await setup(chunks);
  const engine = new Engine({
    character: base.character,
    provider: base.provider,
    speech,
    stateDir: base.dir,
  });
  return { ...base, engine };
}

test("a voiced turn emits speech and a mouth curve after the reply", async () => {
  const speech = new StubSpeech();
  const s = await setupVoice(["嗯，", "今晚没人。"], speech);
  try {
    const events = await collect(s.engine.turn("今晚有人来吗"));
    const kinds = events.map((e) => e.type);
    assert.deepEqual(
      kinds.filter((k) => k !== "delta"),
      ["state", "state", "state", "speech", "mouth", "state", "reply"],
    );

    const speechEvent = events.find((e) => e.type === "speech") as { durationMs: number; audio: unknown };
    assert.equal(speechEvent.durationMs, 500);

    const mouthEvent = events.find((e) => e.type === "mouth") as { frames: { open: number }[] };
    assert.ok(mouthEvent.frames.length > 0, "the curve is derived from the audio, not guessed");
    assert.ok(Math.max(...mouthEvent.frames.map((f) => f.open)) > 0.5);

    // What is spoken is the reply, trimmed, and only once.
    assert.deepEqual(speech.calls, ["嗯，今晚没人。"]);
  } finally {
    await s.cleanup();
  }
});

test("a silent engine still yields a curve, so a renderer is never starved", async () => {
  const s = await setupVoice(["好。"], new SilentSpeech());
  try {
    const events = await collect(s.engine.turn("在吗"));
    const mouth = events.find((e) => e.type === "mouth") as { frames: { open: number }[] };
    assert.ok(mouth, "silent speech still produces frames");
    assert.ok(mouth.frames.length > 0);
    // All-zero audio means an all-closed mouth: correct, and not NaN.
    assert.equal(Math.max(...mouth.frames.map((f) => f.open)), 0);
  } finally {
    await s.cleanup();
  }
});

test("voice can be turned off and then nothing is synthesized", async () => {
  const speech = new StubSpeech();
  const base = await setup(["嗯。"]);
  try {
    const engine = new Engine({
      character: base.character,
      provider: base.provider,
      speech,
      stateDir: base.dir,
      voice: false,
    });
    const events = await collect(engine.turn("在吗"));
    assert.equal(events.filter((e) => e.type === "speech").length, 0);
    assert.deepEqual(speech.calls, []);
  } finally {
    await base.cleanup();
  }
});

test("a speech failure does not cost the transcript", async () => {
  const speech = new StubSpeech(new Error("voice engine offline"));
  const s = await setupVoice(["在。"], speech);
  try {
    await assert.rejects(() => collect(s.engine.turn("在吗")), /voice engine offline/);
    // Both halves are already committed: the reply was decided before speaking.
    const turns = await new MemoryStore(s.dir, "example").load();
    assert.deepEqual(turns.map((t) => t.role), ["user", "assistant"]);
    assert.equal(turns[1].content, "在。");
  } finally {
    await s.cleanup();
  }
});
