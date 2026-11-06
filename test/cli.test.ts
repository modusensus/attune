import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], input: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, "src", "cli.ts"), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("--help explains the flags and exits 0", async () => {
  const r = await runCli(["--help"], "");
  assert.equal(r.code, 0);
  assert.match(r.stderr, /--character/);
  assert.match(r.stderr, /ATTUNE_BASE_URL/);
});

test("a missing --character exits 2 with usage", async () => {
  const r = await runCli([], "");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage:/);
});

test("an unreadable character exits 1 with a config error", async () => {
  const r = await runCli(["--character", join(ROOT, "no-such-character")], "");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /config error/);
});

test("an offline session answers and quits cleanly", async () => {
  const r = await runCli(
    ["--character", join(ROOT, "examples", "example-character")],
    "在吗\n/quit\n",
    { ATTUNE_BASE_URL: "", ATTUNE_MODEL: "" },
  );
  assert.equal(r.code, 0);
  assert.match(r.stdout, /attune · 小满/);
  assert.match(r.stdout, /provider: offline/);
  assert.match(r.stdout, /离线模式/);
});
