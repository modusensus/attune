import { test } from "node:test";
import assert from "node:assert/strict";
import { Framer, framesFromWav, estimateF0, decimate } from "../src/listen/frames.ts";
import { CueTracker, judge, fallFromContour } from "../src/listen/cues.ts";
import { Listener, listenTo } from "../src/listen/listener.ts";
import { encodeWav, decodeWav, resample, type WavAudio } from "../src/audio/wav.ts";

const RATE = 22050;

/** A voiced burst: a tone with a pitch contour, gated at both ends. */
function tone(opts: {
  ms: number;
  fromHz: number;
  toHz: number;
  amp?: number;
  rate?: number;
}): Float32Array {
  const rate = opts.rate ?? RATE;
  const n = Math.round((opts.ms / 1000) * rate);
  const out = new Float32Array(n);
  const amp = opts.amp ?? 0.4;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    const hz = opts.fromHz + (opts.toHz - opts.fromHz) * t;
    phase += (2 * Math.PI * hz) / rate;
    // 10ms fades keep the gate from spraying broadband clicks into the frame.
    const edge = Math.min(1, Math.min(i, n - 1 - i) / (rate * 0.01));
    out[i] = Math.sin(phase) * amp * edge;
  }
  return out;
}

function silence(ms: number, rate = RATE): Float32Array {
  return new Float32Array(Math.round((ms / 1000) * rate));
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function wav(samples: Float32Array, rate = RATE): WavAudio {
  return decodeWav(encodeWav(samples, rate));
}

// --- frames ---------------------------------------------------------------

test("f0 tracks a synthetic tone within a few percent", () => {
  const audio = wav(tone({ ms: 400, fromHz: 150, toHz: 150 }));
  const frames = framesFromWav(audio);
  const voiced = frames.filter((f) => f.f0 > 0);
  assert.ok(voiced.length > frames.length * 0.6, "most of a steady tone is voiced, got " + voiced.length + "/" + frames.length);
  const median = voiced.map((f) => f.f0).sort((a, b) => a - b)[Math.floor(voiced.length / 2)];
  assert.ok(Math.abs(median - 150) / 150 < 0.06, "median f0 was " + median);
});

test("f0 does not fall an octave on a harmonic-rich tone", () => {
  // A sawtooth-like sum is the classic case where a naive global-peak lag picks
  // 2x the period and reports half the pitch.
  const rate = RATE;
  const n = Math.round((rate * 300) / 1000);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ph = (2 * Math.PI * 120 * i) / rate;
    s[i] = 0.3 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.33 * Math.sin(3 * ph));
  }
  const frames = framesFromWav(wav(s));
  const voiced = frames.filter((f) => f.f0 > 0).map((f) => f.f0);
  assert.ok(voiced.length > 5);
  const median = voiced.sort((a, b) => a - b)[Math.floor(voiced.length / 2)];
  assert.ok(median > 100, "expected ~120Hz, got " + median);
});

test("silence produces unvoiced, near-zero frames", () => {
  const frames = framesFromWav(wav(silence(400)));
  assert.ok(frames.length > 5);
  for (const f of frames) {
    assert.equal(f.voiced, false);
    assert.equal(f.f0, 0);
    assert.ok(f.rms < 0.01);
  }
});

test("the streaming framer and the whole-clip framer agree frame for frame", () => {
  const samples = concat(
    tone({ ms: 300, fromHz: 200, toHz: 160 }),
    silence(200),
    tone({ ms: 300, fromHz: 150, toHz: 210 }),
  );
  const audio = wav(samples);
  const offline = framesFromWav(audio);

  // Feed the *decoded* samples, not the ones before the 16-bit round trip: those
  // are a different signal and would fail on the last decimal of every RMS.
  const decoded = audio.samples;
  const framer = new Framer(audio.sampleRate);
  const live = [];
  // Awkward chunk sizes on purpose: a framer that cuts on chunk boundaries
  // would drift here.
  for (let i = 0; i < decoded.length; i += 337) {
    live.push(...framer.push(decoded.subarray(i, Math.min(decoded.length, i + 337))));
  }
  live.push(...framer.flush());

  assert.equal(live.length, offline.length);
  for (let i = 0; i < live.length; i++) {
    assert.equal(live[i].at, offline[i].at, "frame " + i + " timestamp");
    assert.equal(live[i].rms, offline[i].rms, "frame " + i + " rms");
    assert.equal(live[i].f0, offline[i].f0, "frame " + i + " f0");
  }
});

test("estimateF0 refuses a silent window", () => {
  assert.equal(estimateF0(silence(40).subarray(0, 200), RATE, 70, 400, 0.3), 0);
});

test("decimate by 1 is the identity", () => {
  const s = tone({ ms: 20, fromHz: 200, toHz: 200 });
  assert.equal(decimate(s, 1), s);
});

// --- cues -----------------------------------------------------------------

test("a falling contour is read as a full stop, a rising one is not", () => {
  const falling = framesFromWav(wav(tone({ ms: 500, fromHz: 220, toHz: 150 })));
  const rising = framesFromWav(wav(tone({ ms: 500, fromHz: 150, toHz: 220 })));
  const f = fallFromContour(falling.map((x) => x.f0));
  const r = fallFromContour(rising.map((x) => x.f0));
  assert.ok(f < -0.12, "falling contour gave " + f);
  assert.ok(r > 0.12, "rising contour gave " + r);
});

test("a long silence after a falling phrase hands the turn over", () => {
  const frames = framesFromWav(wav(concat(tone({ ms: 500, fromHz: 220, toHz: 150 }), silence(900))));
  const cues = judge(frames);
  const take = cues.find((c) => c.type === "turn_take");
  assert.ok(take, "no turn_take in " + JSON.stringify(cues));
  assert.ok(take.confidence > 0.8, "a clean fall should be confident, got " + take.confidence);
  assert.match(take.reason, /falling/);
});

test("a rising phrase delays the handover instead of grabbing it", () => {
  const shortGap = framesFromWav(wav(concat(tone({ ms: 500, fromHz: 150, toHz: 240 }), silence(900))));
  assert.ok(
    !judge(shortGap).some((c) => c.type === "turn_take"),
    "a rising contour plus 900ms of silence is someone thinking, not someone done",
  );

  // It does hand over eventually — it just takes more silence to be sure.
  const longGap = framesFromWav(wav(concat(tone({ ms: 500, fromHz: 150, toHz: 240 }), silence(1600))));
  const take = judge(longGap).find((c) => c.type === "turn_take");
  assert.ok(take, "trailing off still eventually hands over");
  assert.ok(take.confidence < 0.5, "a rising contour is a weak handover, got " + take.confidence);
  assert.match(take.reason, /rising/);
});

test("a short pause is a hold, not a handover", () => {
  const frames = framesFromWav(wav(concat(tone({ ms: 400, fromHz: 200, toHz: 180 }), silence(350))));
  const cues = judge(frames);
  assert.ok(cues.some((c) => c.type === "hold"), "expected hold, got " + JSON.stringify(cues));
  assert.ok(!cues.some((c) => c.type === "turn_take"), "350ms is not a handover");
});

test("nothing at all is idle", () => {
  const cues = judge(framesFromWav(wav(silence(500))));
  assert.deepEqual(cues.map((c) => c.type), ["idle"]);
});

test("a short burst inside someone else's turn is a backchannel", () => {
  const frames = framesFromWav(
    wav(
      concat(
        tone({ ms: 800, fromHz: 200, toHz: 190 }), // the user, mid-sentence
        silence(120),
        tone({ ms: 180, fromHz: 210, toHz: 205 }), // "mm"
        silence(120),
        tone({ ms: 800, fromHz: 200, toHz: 150 }), // the user finishes
        silence(900),
      ),
    ),
  );
  const cues = judge(frames);
  assert.ok(cues.some((c) => c.type === "backchannel"), "expected backchannel, got " + JSON.stringify(cues));
});

test("the very first short burst is not a backchannel", () => {
  // Someone answering "嗯" at the start of their own turn is not nodding along
  // with you — there is nothing to nod along with yet.
  const frames = framesFromWav(wav(concat(tone({ ms: 180, fromHz: 210, toHz: 205 }), silence(900))));
  const cues = judge(frames);
  assert.ok(!cues.some((c) => c.type === "backchannel"), "got " + JSON.stringify(cues));
});

test("repeated identical cues are suppressed inside the gap window", () => {
  const frames = framesFromWav(
    wav(
      concat(
        tone({ ms: 400, fromHz: 200, toHz: 190 }),
        silence(260),
        tone({ ms: 400, fromHz: 200, toHz: 190 }),
        silence(260),
        tone({ ms: 400, fromHz: 200, toHz: 150 }),
        silence(900),
      ),
    ),
  );
  const cues = judge(frames, { minGapMs: 3000 });
  const holds = cues.filter((c) => c.type === "hold");
  assert.ok(holds.length <= 1, "expected at most one hold, got " + holds.length);
});

// --- listener -------------------------------------------------------------

test("live and offline agree on the same clip", () => {
  const audio = wav(
    concat(
      tone({ ms: 600, fromHz: 210, toHz: 190 }),
      silence(300),
      tone({ ms: 500, fromHz: 200, toHz: 150 }),
      silence(900),
    ),
  );
  const offline = judge(framesFromWav(audio));
  const live = listenTo(audio)
    .filter((e) => e.type === "cue")
    .map((e) => (e as { cue: { type: string; at: number } }).cue);
  assert.deepEqual(
    live.map((c) => [c.type, c.at]),
    offline.map((c) => [c.type, c.at]),
  );
});

test("chunked PCM produces the same cues as one big push", () => {
  const samples = concat(
    tone({ ms: 600, fromHz: 210, toHz: 190 }),
    silence(300),
    tone({ ms: 500, fromHz: 200, toHz: 150 }),
    silence(900),
  );
  const oneShot = new Listener(RATE);
  const a = oneShot.pushPcm(samples);
  a.push(...oneShot.flush());

  const chunked = new Listener(RATE);
  const b = [];
  for (let i = 0; i < samples.length; i += 501) {
    b.push(...chunked.pushPcm(samples.subarray(i, Math.min(samples.length, i + 501))));
  }
  b.push(...chunked.flush());

  const strip = (evs: unknown[]) =>
    evs.map((e) => {
      const ev = e as { type: string; cue?: { type: string; at: number } };
      return ev.cue ? ["cue", ev.cue.type, ev.cue.at] : [ev.type];
    });
  assert.deepEqual(strip(b), strip(a));
});

test("barge-in fires on the first voiced frame while speaking", () => {
  const samples = concat(silence(200), tone({ ms: 400, fromHz: 180, toHz: 180 }));
  const listener = new Listener(RATE);
  listener.setSpeaking(true);
  const events = listener.pushPcm(samples);
  const barge = events.find((e) => e.type === "barge-in") as { at: number } | undefined;
  assert.ok(barge, "no barge-in in " + JSON.stringify(events.map((e) => e.type)));
  // A cue cannot fire before 220ms; the interrupt must come far sooner.
  assert.ok(barge.at < 260, "barge-in at " + barge.at + "ms is too late to stop a voice");
});

test("no barge-in when the character is silent", () => {
  const listener = new Listener(RATE);
  listener.setSpeaking(false);
  const events = listener.pushPcm(concat(silence(100), tone({ ms: 300, fromHz: 180, toHz: 180 })));
  assert.equal(events.filter((e) => e.type === "barge-in").length, 0);
});

test("barge-in fires once per interruption, not on every frame of it", () => {
  const listener = new Listener(RATE);
  listener.setSpeaking(true);
  const events = listener.pushPcm(tone({ ms: 600, fromHz: 180, toHz: 180 }));
  assert.equal(events.filter((e) => e.type === "barge-in").length, 1);
});

test("speaking again re-arms the interrupt", () => {
  const listener = new Listener(RATE);
  listener.setSpeaking(true);
  listener.pushPcm(tone({ ms: 300, fromHz: 180, toHz: 180 }));
  listener.setSpeaking(false);
  listener.setSpeaking(true);
  const events = listener.pushPcm(concat(silence(100), tone({ ms: 300, fromHz: 180, toHz: 180 })));
  assert.equal(events.filter((e) => e.type === "barge-in").length, 1);
});

test("pushPcm rejects a rate the listener was not built for", () => {
  const listener = new Listener(16000);
  assert.throws(() => listener.pushPcm(silence(50), 22050), /was built for 16000Hz/);
});

test("a silent clip through the listener is idle, once", () => {
  const events = listenTo(wav(silence(400)));
  const cues = events.filter((e) => e.type === "cue").map((e) => (e as { cue: { type: string } }).cue.type);
  assert.deepEqual(cues, ["idle"]);
});

test("resample keeps duration and constant frequency", () => {
  const s = tone({ ms: 200, fromHz: 200, toHz: 200, rate: 48000 });
  const down = resample(s, 48000, 16000);
  assert.ok(Math.abs(down.length - s.length / 3) <= 2, "got " + down.length + " from " + s.length);
  const zc = (buf: Float32Array) => {
    let n = 0;
    for (let i = 1; i < buf.length; i++) if ((buf[i - 1] < 0) !== (buf[i] < 0)) n++;
    return n / 2 / 0.2; // cycles over 200ms
  };
  assert.ok(Math.abs(zc(down) - 200) < 20, "pitch drifted to " + zc(down));
});

test("the cue tracker flushes idle only when nothing was ever heard", () => {
  const silent = new CueTracker();
  assert.deepEqual(silent.flush().map((c) => c.type), ["idle"]);

  const spoke = new CueTracker();
  for (const f of framesFromWav(wav(tone({ ms: 400, fromHz: 200, toHz: 150 })))) spoke.push(f);
  spoke.flush();
  assert.ok(!spoke.flush().some((c) => c.type === "idle"));
});