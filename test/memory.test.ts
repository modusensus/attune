import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory.ts";

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "attune-mem-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("append then load round-trips", async () => {
  await withTemp(async (dir) => {
    const store = new MemoryStore(dir, "example");
    await store.append({ role: "user", content: "你好", at: "2026-11-07T00:00:00.000Z" });
    await store.append({ role: "assistant", content: "嗯。", at: "2026-11-07T00:00:01.000Z" });
    const turns = await store.load();
    assert.equal(turns.length, 2);
    assert.equal(turns[0].content, "你好");
    assert.equal(turns[1].role, "assistant");
  });
});

test("missing file reads as empty, not as an error", async () => {
  await withTemp(async (dir) => {
    const store = new MemoryStore(dir, "never-written");
    assert.deepEqual(await store.load(), []);
    assert.deepEqual(await store.recent(5), []);
  });
});

test("a truncated last line is skipped, the rest survives", async () => {
  await withTemp(async (dir) => {
    const store = new MemoryStore(dir, "example");
    await mkdir(join(dir, "memory"), { recursive: true });
    await writeFile(
      store.file,
      '{"role":"user","content":"a","at":"t"}\n{"role":"assist',
      "utf8",
    );
    const turns = await store.load();
    assert.equal(turns.length, 1);
    assert.equal(turns[0].content, "a");
  });
});

test("recent keeps the tail and honours a zero limit", async () => {
  await withTemp(async (dir) => {
    const store = new MemoryStore(dir, "example");
    for (let i = 0; i < 5; i++) {
      await store.append({ role: "user", content: "m" + i, at: "t" });
    }
    const tail = await store.recent(2);
    assert.deepEqual(tail.map((t) => t.content), ["m3", "m4"]);
    assert.deepEqual(await store.recent(0), []);
  });
});

test("namespaces do not leak into each other", async () => {
  await withTemp(async (dir) => {
    const a = new MemoryStore(dir, "alpha");
    const b = new MemoryStore(dir, "beta");
    await a.append({ role: "user", content: "for alpha", at: "t" });
    assert.deepEqual(await b.load(), []);
    assert.equal((await a.load())[0].content, "for alpha");
  });
});
