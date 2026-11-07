import { test } from "node:test";
import assert from "node:assert/strict";
import { SapiAsr, asrFromConfigWithSapi } from "../src/asr-sapi.ts";
import { SapiSpeech, SilentSpeech } from "../src/speech.ts";
import { HAS_SAPI_VOICE, SAPI_GAP } from "./fixtures/sapi.ts";

const IS_WIN = process.platform === "win32";

/** Character overlap, after dropping punctuation: SAPI is not exact and pretending otherwise is worse. */
function overlap(a: string, b: string): number {
  const norm = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");
  const x = norm(a);
  const y = norm(b);
  if (!x.length || !y.length) return 0;
  let hits = 0;
  const pool = [...y];
  for (const ch of x) {
    const i = pool.indexOf(ch);
    if (i >= 0) {
      hits++;
      pool.splice(i, 1);
    }
  }
  return hits / Math.max(x.length, y.length);
}

// This one needs a voice to produce the audio it recognises, so it skips on a
// Windows host that has none - and says which of the two platforms it is on.
test("sapi ears: a synthesised sentence comes back as roughly that sentence", { skip: HAS_SAPI_VOICE ? false : SAPI_GAP }, async () => {
  const said = "今晚有人来吗";
  const clip = await new SapiSpeech().speak(said);
  const t = await new SapiAsr({ language: "zh-CN" }).transcribe(clip.audio);
  assert.equal(t.engine, "sapi");
  assert.ok(t.text.length > 0, "a fluid synthesised sentence must not come back empty");
  // Windows' own recogniser is the 7-era engine; it is noticeably worse than
  // whisper. The bar is "recognisably the same sentence", not equality.
  assert.ok(
    overlap(t.text, said) >= 0.4,
    "recognised " + JSON.stringify(t.text) + " for " + JSON.stringify(said),
  );
  assert.ok(typeof t.language === "string" && t.language.length > 0, "the culture is reported");
  assert.ok(t.durationMs > 100, "the audio duration is carried through");
});

test("sapi ears: silence is heard as nothing, not hallucinated as words", { skip: !IS_WIN }, async () => {
  const clip = await new SilentSpeech().speak("……");
  const t = await new SapiAsr().transcribe(clip.audio);
  assert.equal(t.text, "", "silence must not produce a sentence");
});

test("sapi ears refuse empty audio before spawning powershell", { skip: !IS_WIN }, async () => {
  const empty = {
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
    format: 1,
    samples: new Float32Array(0),
    durationMs: 0,
  };
  await assert.rejects(() => new SapiAsr().transcribe(empty), /nothing to recognise/);
});

test("sapi ears are Windows-only and say so", { skip: IS_WIN }, async () => {
  const audio = {
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
    format: 1,
    samples: new Float32Array(1600),
    durationMs: 100,
  };
  await assert.rejects(() => new SapiAsr().transcribe(audio), /only runs on Windows/);
});

test("the asr factory reaches sapi and still refuses typos", () => {
  assert.equal(asrFromConfigWithSapi({ engine: "sapi" }, {}).id, "sapi");
  assert.equal(asrFromConfigWithSapi({}, {}).id, "silent");
  assert.throws(() => asrFromConfigWithSapi({ engine: "sap" }, {}), /unknown asr engine: sap/);
});
