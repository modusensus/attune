import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NL = String.fromCharCode(10);

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
  assert.match(r.stderr, /ATTUNE_ASR_BASE_URL/);
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
    "在吗" + NL + "/quit" + NL,
    { ATTUNE_BASE_URL: "", ATTUNE_MODEL: "" },
  );
  assert.equal(r.code, 0);
  assert.match(r.stdout, /attune · 小满/);
  assert.match(r.stdout, /provider: offline/);
  assert.match(r.stdout, /离线模式/);
  // With no [asr] block the ear is honest about being none: the microphone is
  // never opened, and /talk explains why instead of recording into a void.
  assert.match(r.stdout, /ears: +silent \(not listening\)/);
  assert.match(r.stdout, /type \/quit to exit\./);
});

test("/talk refuses on a machine with no recogniser", async () => {
  const r = await runCli(
    ["--character", join(ROOT, "examples", "example-character")],
    "/talk" + NL + "/quit" + NL,
    { ATTUNE_BASE_URL: "", ATTUNE_MODEL: "" },
  );
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no recogniser is configured/);
});

test("--say-file drives one turn from a wav with no microphone", async () => {
  const dir = join(ROOT, "out", "_cli-say");
  const wavPath = join(dir, "in.wav");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { encodeWav } = await import("../src/audio/wav.ts");
  await mkdir(dir, { recursive: true });
  const samples = new Float32Array(16000);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 220 * i) / 16000) * 0.3;
  await writeFile(wavPath, encodeWav(samples, 16000));

  const r = await runCli(
    ["--character", join(ROOT, "examples", "example-character"), "--say-file", wavPath],
    "",
    { ATTUNE_BASE_URL: "", ATTUNE_MODEL: "" },
  );
  // silent ears hear nothing, so there is no turn to take — and that is reported
  // as a failure rather than as a successful empty conversation.
  assert.equal(r.code, 1);
  assert.match(r.stdout, /heard: +\(nothing\)/);
  assert.match(r.stderr, /nothing was recognised, so there is no turn to take/);
});

test("--say-file with a real recogniser takes the recognised turn", { skip: process.platform !== "win32" }, async () => {
  const dir = join(ROOT, "out", "_cli-say2");
  const wavPath = join(dir, "in.wav");
  const characterDir = join(dir, "character");
  const { mkdir, writeFile, cp } = await import("node:fs/promises");
  const { encodeWav } = await import("../src/audio/wav.ts");
  const { SapiSpeech } = await import("../src/speech.ts");
  await mkdir(characterDir, { recursive: true });
  await cp(join(ROOT, "examples", "example-character", "persona.md"), join(characterDir, "persona.md"));
  await writeFile(
    join(characterDir, "character.toml"),
    [
      "[identity]",
      'name = "小满"',
      'persona = "persona.md"',
      "",
      "[voice]",
      'engine = "none"',
      "",
      "[asr]",
      'engine = "sapi"',
      'language = "zh-CN"',
      "",
    ].join(NL),
  );

  const clip = await new SapiSpeech().speak("今晚有人来吗");
  await writeFile(wavPath, encodeWav(clip.audio.samples, clip.audio.sampleRate));

  const r = await runCli(["--character", characterDir, "--say-file", wavPath, "--text-only"], "", {
    ATTUNE_BASE_URL: "",
    ATTUNE_MODEL: "",
  });
  assert.equal(r.code, 0, "stderr: " + r.stderr);
  assert.match(r.stdout, /ears: +sapi/);
  assert.match(r.stdout, /heard: +".+"/, "the wav must be recognised, got: " + r.stdout);
  assert.match(r.stdout, /小满: /);
});
