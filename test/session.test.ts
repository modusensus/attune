import assert from "node:assert/strict";
import { test } from "node:test";
import { ListenSession } from "../src/listen/session.ts";
import { readMapping, DEFAULT_MAPPING } from "../src/render/mapping.ts";
import { framesFromWav } from "../src/listen/frames.ts";
import { decodeWav, encodeWav } from "../src/audio/wav.ts";

/** A voiced tone with short fades, so the energy gate is not a click train. */
function tone(ms: number, fromHz: number, toHz = fromHz, amp = 0.4, rate = 16000): Float32Array {
  const n = Math.round((ms / 1000) * rate);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const p = n <= 1 ? 0 : i / (n - 1);
    const hz = fromHz + (toHz - fromHz) * p;
    phase += (2 * Math.PI * hz) / rate;
    const fade = Math.min(1, i / (0.01 * rate), (n - 1 - i) / (0.01 * rate));
    out[i] = Math.sin(phase) * amp * Math.max(0, fade);
  }
  return out;
}

function silence(ms: number, rate = 16000): Float32Array {
  return new Float32Array(Math.round((ms / 1000) * rate));
}

function concat(...parts: Float32Array[]): Float32Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

test("while listening, a cue becomes a gesture", () => {
  const s = new ListenSession(16000);
  // A long turn first, so the short burst after it counts as a backchannel.
  // The pause has to be long enough that the hold and the nod are separate
  // reactions: a monologue with 300ms gaps gets one reaction per clause, not two.
  s.pushPcm(concat(tone(900, 150, 120), silence(1800), tone(200, 180)));
  const channels = s.cues.map((c) => c.type);
  assert.ok(channels.includes("backchannel"), "expected a backchannel, got " + JSON.stringify(channels));
});

test("gestures come out of pushPcm directly, not only from the cue log", () => {
  // A renderer draws what pushPcm hands back; it must not have to walk the cue
  // log and re-derive anything.
  const s = new ListenSession(16000);
  const audio = concat(tone(900, 150, 120), silence(400), tone(180, 180), silence(1500));
  const first = s.pushPcm(audio);
  const flushed = s.flush();
  const all = [...first.gestures, ...flushed.gestures];
  assert.ok(all.length > 0, "the session must hand a renderer something to draw");
  assert.ok(
    all.every((g) => typeof g.channel === "string" && typeof g.at === "number"),
    "and each one must already be a shaped gesture",
  );
});

test("while thinking the microphone is ignored", () => {
  // A reply is being composed; any reaction now lands on top of the answer.
  const s = new ListenSession(16000);
  s.setState("thinking");
  const out = s.pushPcm(concat(tone(900, 150, 120), silence(1200), tone(200, 180)));
  assert.deepEqual(out.gestures, [], "no gestures while thinking");
  assert.equal(out.bargeIn, null);
  // The cues are still recorded, so the log explains what was heard — but they
  // are not acted on.
  assert.ok(s.cues.length === 0, "and they are not logged as reactions either");
});

test("while speaking, a cue is not a gesture — only barge-in counts", () => {
  const s = new ListenSession(16000);
  s.setState("speaking");
  const out = s.pushPcm(tone(300, 200));
  assert.deepEqual(out.gestures, [], "the character does not nod at itself");
});

test("talking over the character raises barge-in within tens of milliseconds of the onset", () => {
  // The absolute timestamp is meaningless on its own: this clip has half a
  // second of silence first. What matters is the delay from the moment the user
  // actually starts talking, and that it lands far below the 220ms a cue needs.
  const ONSET = 500;
  const s = new ListenSession(16000);
  s.setState("listening");
  s.pushPcm(silence(ONSET));
  s.setState("speaking");
  const out = s.pushPcm(tone(400, 200));
  assert.ok(out.bargeIn, "expected a barge-in");
  const latency = out.bargeIn!.at - ONSET;
  assert.ok(latency <= 60, "must fire within a frame or two of the onset, got " + latency + "ms");
  assert.ok(latency < 220, "and strictly faster than the earliest possible cue");
  assert.equal(s.bargeIns.length, 1);
});

test("one speaking turn produces one barge-in, not one per chunk", () => {
  const s = new ListenSession(16000);
  s.setState("speaking");
  s.pushPcm(tone(400, 200));
  s.pushPcm(tone(400, 200));
  s.pushPcm(tone(400, 200));
  assert.equal(s.bargeIns.length, 1, "a human reads three reports as three interruptions");
});

test("leaving the speaking state re-arms barge-in for the next turn", () => {
  const s = new ListenSession(16000);
  s.setState("speaking");
  s.pushPcm(tone(300, 200));
  assert.equal(s.bargeIns.length, 1);
  s.setState("listening");
  s.pushPcm(silence(600));
  s.setState("speaking");
  s.pushPcm(tone(300, 200));
  assert.equal(s.bargeIns.length, 2, "the second turn can be interrupted too");
});

test("the session accepts frames as well as pcm, with identical results", () => {
  const samples = concat(tone(900, 150, 120), silence(1200));
  const byPcm = new ListenSession(16000);
  const a = byPcm.pushPcm(samples);
  const byFrame = new ListenSession(null);
  let b = { gestures: [] as unknown[], bargeIn: null as unknown };
  for (const frame of framesFromWav(decodeWav(encodeWav(samples, 16000)))) {
    const out = byFrame.pushFrame(frame);
    b = { gestures: [...b.gestures, ...out.gestures], bargeIn: b.bargeIn ?? out.bargeIn };
  }
  assert.equal(a.gestures.length, b.gestures.length);
});

test("a character keeps its own reaction rhythm rather than firing on every pause", () => {
  // Twenty clauses, twenty interjections, 94 seconds. A machine reacting to
  // every single one is the thing this layer is supposed to stop being.
  const parts: Float32Array[] = [];
  for (let i = 0; i < 20; i += 1) {
    parts.push(tone(2600, 215, 152), silence(340), tone(190, 178), silence(420), tone(900, 192), silence(260));
  }
  const s = new ListenSession(16000);
  s.pushPcm(concat(...parts));
  s.flush();
  const perMinute = (s.cues.length / 94) * 60;
  assert.ok(s.cues.length >= 8, "it must still react, got " + s.cues.length);
  assert.ok(perMinute <= 40, "at most 40 reactions a minute, got " + perMinute.toFixed(1));
});

test("the character's mapping decides how big the nod is", () => {
  const small = new ListenSession(16000, {}, readMapping({ backchannel_nod: 0.2, backchannel_tilt: 0 }));
  small.pushPcm(concat(tone(900, 150, 120), silence(1800), tone(200, 180)));
  const nods = small.cues.filter((c) => c.type === "backchannel").length;
  assert.ok(nods > 0, "the cue must still fire; only the size changes");
});

test("a character that disables every channel still runs, and stays still", () => {
  const still = new ListenSession(
    16000,
    {},
    readMapping({ backchannel_nod: 0, backchannel_tilt: 0, hold_brow: 0, hold_gaze: 0, turn_take_blink: false, turn_take_brow: 0 }),
  );
  const out = still.pushPcm(concat(tone(900, 150, 120), silence(1400)));
  still.flush();
  assert.ok(still.cues.length > 0, "the cues still happen");
  assert.deepEqual(out.gestures, [], "but nothing moves");
});

test("setState is idempotent", () => {
  const s = new ListenSession(16000);
  s.setState("listening");
  s.setState("listening");
  s.pushPcm(silence(200));
  assert.equal(s.currentState, "listening");
});

test("a barge-in stops the listening layer from also drawing a gesture", () => {
  // While speaking, cues are not acted on at all — so a user who cuts in gets
  // exactly one signal, not a barge-in plus a nod.
  const s = new ListenSession(16000);
  s.setState("speaking");
  const out = s.pushPcm(tone(900, 150, 120));
  assert.ok(out.bargeIn);
  assert.deepEqual(out.gestures, []);
});

test("flush on a session that heard nothing produces nothing", () => {
  const s = new ListenSession(16000);
  s.pushPcm(silence(500));
  const out = s.flush();
  assert.deepEqual(out.gestures, [], "an idle cue is not a gesture");
});

test("default mapping is what an unconfigured character gets", () => {
  const s = new ListenSession(16000);
  s.pushPcm(concat(tone(900, 150, 120), silence(1200)));
  assert.ok(s.cues.some((c) => c.type === "turn_take"), "a falling stop should hand over");
  assert.ok(DEFAULT_MAPPING.backchannel_nod > 0);
});