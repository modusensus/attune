import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { SilentSpeech, SapiSpeech, HttpSpeech, SpeechError, speechFromConfig } from "../src/speech.ts";
import { encodeWav } from "../src/audio/wav.ts";

const IS_WIN = process.platform === "win32";

function wavBytes(samples: Float32Array, rate = 22050): Buffer {
  return Buffer.from(encodeWav(samples, rate));
}

async function withServer(
  handler: (req: import("node:http").IncomingMessage, body: string) => { status: number; body: Buffer | string; type?: string },
  run: (baseUrl: string, seen: { path: string; body: string; headers: Record<string, string | string[] | undefined> }[]) => Promise<void>,
): Promise<void> {
  const seen: { path: string; body: string; headers: Record<string, string | string[] | undefined> }[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", body, headers: req.headers });
      const out = handler(req, body);
      res.writeHead(out.status, { "content-type": out.type ?? "audio/wav" });
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

test("the silent engine produces correctly timed silence, not nothing", async () => {
  const clip = await new SilentSpeech().speak("今晚有人来吗？");
  assert.equal(clip.engine, "silent");
  assert.equal(clip.audio.sampleRate, 22050);
  assert.ok(clip.audio.samples.length > 0, "silent audio still has samples");
  assert.ok(clip.audio.durationMs > 400, "duration " + clip.audio.durationMs);
  // Seven characters at 220ms each, floored at 400ms.
  assert.ok(Math.abs(clip.audio.durationMs - 7 * 220) < 50, "duration " + clip.audio.durationMs);
  for (let i = 0; i < clip.audio.samples.length; i++) assert.equal(clip.audio.samples[i], 0);
});

test("the silent engine refuses empty text", async () => {
  await assert.rejects(() => new SilentSpeech().speak("   "), /nothing to say/);
});

test("the http engine posts the OpenAI speech payload and decodes the wav", async () => {
  const expected = wavBytes(new Float32Array([0.5, -0.5, 0.25]));
  await withServer(
    () => ({ status: 200, body: expected }),
    async (baseUrl, seen) => {
      const speech = new HttpSpeech({ baseUrl, model: "tts-1", voice: "alloy", apiKey: "secret" });
      assert.equal(speech.id, "http:tts-1");
      const clip = await speech.speak("你好");
      assert.equal(clip.audio.samples.length, 3);
      assert.equal(clip.text, "你好");
      assert.equal(seen[0].path, "/audio/speech");
      assert.equal(seen[0].headers.authorization, "Bearer secret");
      const payload = JSON.parse(seen[0].body);
      assert.equal(payload.model, "tts-1");
      assert.equal(payload.input, "你好");
      assert.equal(payload.voice, "alloy");
      assert.equal(payload.response_format, "wav");
    },
  );
});

test("the http engine leaves voice out when none is configured", async () => {
  await withServer(
    () => ({ status: 200, body: wavBytes(new Float32Array(2)) }),
    async (baseUrl, seen) => {
      await new HttpSpeech({ baseUrl, model: "m" }).speak("hi");
      assert.equal(JSON.parse(seen[0].body).voice, undefined);
    },
  );
});

test("a non-2xx speech response becomes a SpeechError carrying the body", async () => {
  await withServer(
    () => ({ status: 500, body: "model not loaded", type: "text/plain" }),
    async (baseUrl) => {
      const speech = new HttpSpeech({ baseUrl, model: "m" });
      await assert.rejects(() => speech.speak("hi"), /HTTP 500: model not loaded/);
    },
  );
});

test("a refused speech connection explains what to check", async () => {
  const speech = new HttpSpeech({ baseUrl: "http://127.0.0.1:1", model: "m" });
  await assert.rejects(() => speech.speak("hi"), /cannot reach http:\/\/127\.0\.0\.1:1/);
});

test("a speech server that returns something other than wav fails loudly", async () => {
  await withServer(
    () => ({ status: 200, body: "not a wav file", type: "audio/wav" }),
    async (baseUrl) => {
      const speech = new HttpSpeech({ baseUrl, model: "m" });
      await assert.rejects(() => speech.speak("hi"), /not a wav file|RIFF/);
    },
  );
});

test("trailing slashes in the speech baseUrl do not double up the path", async () => {
  await withServer(
    () => ({ status: 200, body: wavBytes(new Float32Array(2)) }),
    async (baseUrl, seen) => {
      await new HttpSpeech({ baseUrl: baseUrl + "///", model: "m" }).speak("hi");
      assert.equal(seen[0].path, "/audio/speech");
    },
  );
});

test("config picks the engine and refuses a typo instead of falling back", () => {
  assert.equal(speechFromConfig({ engine: "none" }, {}).id, "silent");
  assert.equal(speechFromConfig({ engine: "silent" }, {}).id, "silent");
  assert.equal(speechFromConfig({}, {}).id, "silent", "missing engine defaults to silent");
  assert.equal(speechFromConfig({ engine: "sapi" }, {}).id, "sapi");
  assert.equal(
    speechFromConfig({ engine: "http", model: "tts-1" }, { ATTUNE_TTS_BASE_URL: "http://x" }).id,
    "http:tts-1",
  );
  assert.throws(() => speechFromConfig({ engine: "http", model: "tts-1" }, {}), /ATTUNE_TTS_BASE_URL/);
  assert.throws(() => speechFromConfig({ engine: "gpt-sovits" }, {}), /unknown voice engine: gpt-sovits/);
});

test("sapi refuses to pretend it works on a non-Windows host", { skip: IS_WIN }, async () => {
  await assert.rejects(() => new SapiSpeech().speak("hi"), /only runs on Windows/);
});

test("sapi really synthesizes audio on Windows", { skip: !IS_WIN, timeout: 120000 }, async () => {
  // Integration, not a unit test: it proves the PowerShell child, the temp
  // files, the encoding and the decoder all work together on a stock box.
  const clip = await new SapiSpeech().speak("今晚有人来吗？");
  assert.equal(clip.engine, "sapi");
  assert.ok(clip.audio.samples.length > 1000, "samples " + clip.audio.samples.length);
  assert.ok(clip.audio.durationMs > 300, "duration " + clip.audio.durationMs);
  assert.ok(clip.audio.sampleRate >= 8000, "rate " + clip.audio.sampleRate);
  // Real speech is not silence: the peak must be clearly above the noise floor.
  let peak = 0;
  for (let i = 0; i < clip.audio.samples.length; i++) {
    const v = Math.abs(clip.audio.samples[i]);
    if (v > peak) peak = v;
  }
  assert.ok(peak > 0.2, "peak amplitude " + peak);
});

test("sapi refuses empty text before spawning anything", async () => {
  await assert.rejects(() => new SapiSpeech().speak(""), /nothing to say/);
});
