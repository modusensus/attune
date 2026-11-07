import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  AsrError,
  CliAsr,
  HttpAsr,
  SilentAsr,
  asrFromConfig,
  canHear,
  multipartBody,
  parseTranscriptBody,
  splitArgs,
} from "../src/asr.ts";
import { encodeWav, type WavAudio } from "../src/audio/wav.ts";

const IS_WIN = process.platform === "win32";

function audio(ms = 500, rate = 16000): WavAudio {
  const n = Math.round((ms / 1000) * rate);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * 220 * i) / rate) * 0.3;
  const bytes = encodeWav(samples, rate);
  // Round-trip so the fixture is exactly what a decoded wav looks like.
  return {
    sampleRate: rate,
    channels: 1,
    bitsPerSample: 16,
    format: 1,
    samples,
    durationMs: ms,
  };
}

async function withServer(
  handler: (req: import("node:http").IncomingMessage, body: Buffer) => { status: number; body: string; type?: string },
  run: (baseUrl: string, seen: { path: string; body: Buffer; headers: Record<string, string | string[] | undefined> }[]) => Promise<void>,
): Promise<void> {
  const seen: { path: string; body: Buffer; headers: Record<string, string | string[] | undefined> }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ path: req.url ?? "", body, headers: req.headers });
      const out = handler(req, body);
      res.writeHead(out.status, { "content-type": out.type ?? "application/json" });
      res.end(out.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await run("http://127.0.0.1:" + port, seen);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("the silent recogniser hears nothing and says so", async () => {
  const t = await new SilentAsr().transcribe(audio());
  assert.equal(t.engine, "silent");
  assert.equal(t.text, "");
  assert.equal(t.durationMs, 500);
  assert.equal(canHear(new SilentAsr()), false);
});

test("multipart encoding puts the file last and terminates the boundary", () => {
  const body = multipartBody(
    "BOUND",
    { model: "whisper-1", response_format: "json" },
    { field: "file", filename: "a.wav", contentType: "audio/wav", bytes: new Uint8Array([1, 2, 3]) },
  );
  const text = body.toString("latin1");
  assert.ok(text.startsWith("--BOUND\r\n"), "body opens with the boundary");
  assert.ok(text.includes('Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n'));
  assert.ok(text.includes('name="file"; filename="a.wav"'));
  assert.ok(text.includes("Content-Type: audio/wav\r\n\r\n"));
  assert.ok(text.endsWith("--BOUND--\r\n"), "body closes with the terminator");
  // The raw bytes of the audio must survive untouched.
  assert.ok(body.includes(Buffer.from([1, 2, 3])));
});

test("transcript bodies: json, bare text, and the two ways to be useless", () => {
  assert.equal(parseTranscriptBody('{"text":"今晚有人来吗"}').text, "今晚有人来吗");
  assert.equal(parseTranscriptBody("  今晚有人来吗\n").text, "今晚有人来吗");
  assert.equal(parseTranscriptBody('{"text":"你好","language":"zh"}').language, "zh");
  assert.throws(() => parseTranscriptBody("<html><body>请先登录</body></html>"), /returned HTML instead of a transcript/);
  // A different dialect is loud, not empty: dropping it would look like "heard
  // nothing" while the user's sentence quietly disappeared.
  assert.throws(() => parseTranscriptBody('{"segment":"nope"}'), /without a text field/);
  assert.throws(() => parseTranscriptBody(""), /empty body/);
});

test("a transcript that is only whitespace becomes empty text, not a turn", () => {
  assert.equal(parseTranscriptBody('{"text":"   "}').text.trim(), "");
});

test("splitArgs respects quotes and refuses to be a shell", () => {
  assert.deepEqual(splitArgs("whisper-cli --model m.bin {audio}"), ["whisper-cli", "--model", "m.bin", "{audio}"]);
  assert.deepEqual(splitArgs('"/c/Program Files/w.bat" -f {audio}'), ["/c/Program Files/w.bat", "-f", "{audio}"]);
  assert.deepEqual(splitArgs("a  b\tc"), ["a", "b", "c"]);
  assert.throws(() => splitArgs('a "b'), /unbalanced quote in asr command/);
});

test("http engine posts audio as multipart and reads the text back", async () => {
  await withServer(
    () => ({ status: 200, body: JSON.stringify({ text: "外面在下雨", language: "zh" }) }),
    async (baseUrl, seen) => {
      const asr = new HttpAsr({ baseUrl, model: "whisper-1", apiKey: "k", language: "zh" });
      const t = await asr.transcribe(audio(300));
      assert.equal(t.text, "外面在下雨");
      assert.equal(t.engine, "http:whisper-1");
      assert.equal(t.durationMs, 300);
      assert.equal(seen[0].path, "/audio/transcriptions");
      assert.equal(seen[0].headers.authorization, "Bearer k");
      const body = seen[0].body.toString("latin1");
      assert.ok(body.includes('name="model"\r\n\r\nwhisper-1'));
      assert.ok(body.includes('name="language"\r\n\r\nzh'));
      assert.ok(body.includes('filename="utterance.wav"'));
      assert.ok(body.includes("RIFF"), "the wav bytes are in the request");
    },
  );
});

test("http engine without a language does not send an empty field", async () => {
  await withServer(
    () => ({ status: 200, body: '{"text":"hi"}' }),
    async (baseUrl, seen) => {
      await new HttpAsr({ baseUrl, model: "m" }).transcribe(audio(100));
      assert.ok(!seen[0].body.toString("latin1").includes('name="language"'));
    },
  );
});

test("http engine surfaces a server error instead of returning empty text", async () => {
  await withServer(
    () => ({ status: 500, body: "model not loaded", type: "text/plain" }),
    async (baseUrl) => {
      await assert.rejects(
        () => new HttpAsr({ baseUrl, model: "m" }).transcribe(audio(100)),
        /HTTP 500: model not loaded/,
      );
    },
  );
});

test("http engine explains a refused connection in terms of the setting", async () => {
  const asr = new HttpAsr({ baseUrl: "http://127.0.0.1:1", model: "m" });
  await assert.rejects(() => asr.transcribe(audio(100)), /ATTUNE_ASR_BASE_URL/);
});

test("http engine refuses to transcribe nothing", async () => {
  const asr = new HttpAsr({ baseUrl: "http://127.0.0.1:1", model: "m" });
  const empty: WavAudio = { sampleRate: 16000, channels: 1, bitsPerSample: 16, format: 1, samples: new Float32Array(0), durationMs: 0 };
  await assert.rejects(() => asr.transcribe(empty), /nothing to recognise/);
});

test("cli engine runs a command that prints text", async () => {
  const asr = new CliAsr({
    command: process.execPath + ' -e "process.stdout.write(\'外面在下雨\')" {audio}',
    timeoutMs: 30000,
  });
  const t = await asr.transcribe(audio(200));
  assert.equal(t.text, "外面在下雨");
  // basename(process.execPath) is "node" on unix and "node.exe" on Windows.
  assert.ok(t.engine.startsWith("cli:node"), "engine id names the binary, got " + t.engine);
});

test("cli engine refuses a command with no {audio} placeholder", () => {
  assert.throws(() => new CliAsr({ command: "whisper-cli --model m" }), /needs an \{audio\} placeholder/);
});

test("cli engine reports a failing command with its stderr", async () => {
  const asr = new CliAsr({
    command: process.execPath + ' -e "process.stderr.write(\'boom\'); process.exit(3)" {audio}',
    timeoutMs: 30000,
  });
  await assert.rejects(() => asr.transcribe(audio(100)), /exited with code 3: boom/);
});

test("asrFromConfig defaults to silent and translates every engine", () => {
  assert.equal(asrFromConfig({}, {}).id, "silent");
  assert.equal(asrFromConfig({ engine: "none" }, {}).id, "silent");
  assert.equal(asrFromConfig({ engine: "silent" }, {}).id, "silent");
  assert.equal(
    asrFromConfig({ engine: "whisper", model: "whisper-1" }, { ATTUNE_ASR_BASE_URL: "http://x/v1" }).id,
    "http:whisper-1",
  );
  assert.equal(
    asrFromConfig({ engine: "cli", command: "foo {audio}" }, {}).id,
    "cli:foo",
  );
});

test("asrFromConfig refuses a typo instead of falling back to silent", () => {
  assert.throws(
    () => asrFromConfig({ engine: "whisper-cpp" }, {}),
    /unknown asr engine: whisper-cpp \(expected none, silent, http, or cli\)/,
  );
});

test("asrFromConfig explains what an http engine is missing", () => {
  assert.throws(() => asrFromConfig({ engine: "http" }, {}), /needs ATTUNE_ASR_BASE_URL and a model/);
  assert.throws(
    () => asrFromConfig({ engine: "http" }, { ATTUNE_ASR_BASE_URL: "http://x/v1" }),
    /needs ATTUNE_ASR_BASE_URL and a model/,
  );
});

test("asrFromConfig reads the model and command from the environment too", () => {
  assert.equal(
    asrFromConfig({ engine: "http" }, { ATTUNE_ASR_BASE_URL: "http://x/v1", ATTUNE_ASR_MODEL: "env-m" }).id,
    "http:env-m",
  );
  assert.equal(
    asrFromConfig({ engine: "cli" }, { ATTUNE_ASR_COMMAND: "bar --x {audio}" }).id,
    "cli:bar",
  );
});
