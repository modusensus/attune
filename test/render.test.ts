import assert from "node:assert/strict";
import { test } from "node:test";
import { gestureAt, gesturesAt, channelsBetween, gesturesStartingBetween, gestureDuration } from "../src/render/gesture.ts";
import { readMapping, mapCues, MappingError, MAPPING_KEYS, DEFAULT_MAPPING, MIN_CONFIDENCE } from "../src/render/mapping.ts";
import type { Cue } from "../src/listen/cues.ts";

const nod = { channel: "nod", at: 100, peak: 0.8, riseMs: 100, holdMs: 100, fallMs: 100 };

test("a gesture is zero before it starts and after it ends", () => {
  assert.equal(gestureAt(nod, 0), 0);
  assert.equal(gestureAt(nod, 99), 0);
  assert.equal(gestureAt(nod, 500), 0);
  assert.equal(gestureAt(nod, 10000), 0);
});

test("a gesture rises, holds, and falls", () => {
  // nod: starts at 100, rises for 100, holds for 100, falls for 100.
  assert.ok(Math.abs(gestureAt(nod, 150) - 0.4) < 1e-9, "halfway up");
  assert.equal(gestureAt(nod, 200), 0.8, "peak at the top of the rise");
  assert.equal(gestureAt(nod, 250), 0.8, "still at peak through the hold");
  assert.equal(gestureAt(nod, 300), 0.8, "the hold ends here, the fall has not started");
  assert.ok(Math.abs(gestureAt(nod, 350) - 0.4) < 1e-9, "halfway down");
});

test("a zero-length gesture is invisible rather than a division by zero", () => {
  // A gesture with no duration occupies no time. Returning 1 at the exact
  // instant would be a frame a 60fps renderer never samples — the honest answer
  // is that this gesture cannot be seen, and it must not produce NaN.
  const instant = { channel: "blink", at: 10, peak: 1, riseMs: 0, holdMs: 0, fallMs: 0 };
  assert.equal(gestureAt(instant, 10), 0);
  assert.equal(gestureAt(instant, 11), 0);
  assert.ok(Number.isFinite(gestureAt(instant, 10)));
  assert.ok(Number.isFinite(gestureAt(instant, 11)));

  // A rise of zero is still fine when there is a hold to land on.
  const snap = { channel: "blink", at: 0, peak: 1, riseMs: 0, holdMs: 60, fallMs: 90 };
  assert.equal(gestureAt(snap, 0), 1, "instant rise reaches the peak immediately");
  assert.equal(gestureAt(snap, 30), 1);
  assert.ok(Math.abs(gestureAt(snap, 105) - 0.5) < 1e-9);
});

test("peak is clamped to 0..1 and a zero peak never fires", () => {
  assert.equal(gestureAt({ ...nod, peak: 5 }, 200), 1);
  assert.equal(gestureAt({ ...nod, peak: -1 }, 200), 0);
  assert.equal(gestureAt({ ...nod, peak: 0 }, 200), 0);
});

test("gestureDuration is the full span", () => {
  assert.equal(gestureDuration(nod), 300);
});

test("overlapping gestures on one channel take the max, not the sum", () => {
  // Two nods that overlap: a rig given 1.6 on a neck parameter falls over.
  const a = { channel: "nod", at: 0, peak: 0.8, riseMs: 100, holdMs: 100, fallMs: 100 };
  const b = { channel: "nod", at: 150, peak: 0.7, riseMs: 100, holdMs: 100, fallMs: 100 };
  const at200 = gesturesAt([a, b], 200);
  assert.ok(at200.nod <= 1, "never exceeds 1, got " + at200.nod);
  assert.equal(at200.nod, 0.8);
});

test("different channels coexist", () => {
  // blink is over in 30ms; sample where both are actually moving.
  const a = { channel: "nod", at: 0, peak: 0.5, riseMs: 100, holdMs: 100, fallMs: 100 };
  const b = { channel: "blink", at: 0, peak: 1, riseMs: 10, holdMs: 10, fallMs: 10 };
  const at5 = gesturesAt([a, b], 5);
  assert.deepEqual(Object.keys(at5).sort(), ["blink", "nod"]);
  assert.ok(at5.nod > 0 && at5.blink > 0);

  // Once blink is done it drops out of the map instead of sitting there at 0.
  assert.deepEqual(Object.keys(gesturesAt([a, b], 50)), ["nod"]);
});

test("channelsBetween reports what is active in a window, and ignores the rest", () => {
  const g = [
    { channel: "nod", at: 0, peak: 1, riseMs: 100, holdMs: 0, fallMs: 100 },
    { channel: "blink", at: 5000, peak: 1, riseMs: 10, holdMs: 10, fallMs: 10 },
  ];
  assert.deepEqual(channelsBetween(g, 0, 1000), ["nod"]);
  assert.deepEqual(channelsBetween(g, 4000, 6000), ["blink"]);
  assert.deepEqual(channelsBetween(g, 2000, 3000), []);
});

test("gesturesStartingBetween counts only reactions that begin in the window", () => {
  // The nod at 0 is still fading out at 150, but it did not start there.
  const g = [
    { channel: "nod", at: 0, peak: 1, riseMs: 100, holdMs: 0, fallMs: 200 },
    { channel: "blink", at: 200, peak: 1, riseMs: 10, holdMs: 10, fallMs: 10 },
  ];
  assert.deepEqual(gesturesStartingBetween(g, 150, 400).map((x) => x.channel), ["blink"]);
});

// ---- mapping ----

function cue(type: Cue["type"], at: number, confidence = 0.8): Cue {
  return { type, at, confidence, reason: "test" };
}

test("readMapping fills defaults for a missing table", () => {
  assert.deepEqual(readMapping({}), DEFAULT_MAPPING);
  assert.deepEqual(readMapping(), DEFAULT_MAPPING);
});

test("readMapping keeps explicit values and allows zero to mean off", () => {
  const m = readMapping({ backchannel_nod: 0, hold_brow: 1 });
  assert.equal(m.backchannel_nod, 0);
  assert.equal(m.hold_brow, 1);
  assert.equal(m.backchannel_tilt, DEFAULT_MAPPING.backchannel_tilt, "unset keys keep their default");
});

test("readMapping rejects unknown keys instead of ignoring them", () => {
  // A typo that does nothing is the worst failure mode: the character looks
  // broken and the config looks fine.
  assert.throws(() => readMapping({ backchannel_nodd: 0.5 }), (err: Error) => {
    assert.ok(err instanceof MappingError);
    assert.match(err.message, /unknown mapping key: backchannel_nodd/);
    assert.match(err.message, /backchannel_nod/, "the error lists the valid keys");
    return true;
  });
});

test("readMapping rejects out-of-range and wrongly typed values", () => {
  assert.throws(() => readMapping({ backchannel_nod: -0.2 }), /between 0 and 1/);
  assert.throws(() => readMapping({ backchannel_nod: 1.5 }), /between 0 and 1/);
  assert.throws(() => readMapping({ backchannel_nod: "0.5" as unknown as number }), /must be a number/);
  assert.throws(() => readMapping({ turn_take_blink: 1 as unknown as boolean }), /must be true or false/);
});

test("every documented mapping key is accepted", () => {
  const raw: Record<string, unknown> = {};
  for (const key of MAPPING_KEYS) raw[key] = key === "turn_take_blink" ? false : 0.5;
  assert.doesNotThrow(() => readMapping(raw));
});

test("a backchannel becomes a nod and a tilt, in that order", () => {
  const g = mapCues([cue("backchannel", 300)], DEFAULT_MAPPING);
  assert.deepEqual(g.map((x) => x.channel), ["nod", "head_tilt"]);
  assert.equal(g[0].at, 300, "the gesture starts when the cue landed");
  assert.equal(g[0].peak, DEFAULT_MAPPING.backchannel_nod);
});

test("a hold is quieter than a backchannel and never a nod", () => {
  const g = mapCues([cue("hold", 250)], DEFAULT_MAPPING);
  const channels = g.map((x) => x.channel);
  assert.deepEqual(channels, ["brow_raise", "gaze_shift"]);
  assert.ok(!channels.includes("nod"), "a pause is not applause");
});

test("turn_take gets the go-on face and a blink", () => {
  const g = mapCues([cue("turn_take", 700)], DEFAULT_MAPPING);
  assert.deepEqual(g.map((x) => x.channel), ["brow_raise", "blink"]);
  const noBlink = mapCues([cue("turn_take", 700)], { ...DEFAULT_MAPPING, turn_take_blink: false });
  assert.deepEqual(noBlink.map((x) => x.channel), ["brow_raise"]);
});

test("idle produces no gesture at all", () => {
  // Nothing happening is a valid state of a face. Inventing motion so the
  // screen is never still is how characters become screensavers.
  assert.deepEqual(mapCues([cue("idle", 0, 0.2)]), []);
});

test("low-confidence cues are gated out entirely, not scaled down", () => {
  const quiet = mapCues([cue("turn_take", 100, MIN_CONFIDENCE - 0.01)]);
  assert.deepEqual(quiet, []);
  const loud = mapCues([cue("turn_take", 100, MIN_CONFIDENCE)]);
  assert.ok(loud.length > 0, "exactly at the threshold still fires");
  assert.equal(loud[0].peak, DEFAULT_MAPPING.turn_take_brow, "confidence does not scale the peak");
});

test("a channel mapped to zero produces no gesture, and other channels still fire", () => {
  const g = mapCues([cue("backchannel", 100)], { ...DEFAULT_MAPPING, backchannel_nod: 0 });
  assert.deepEqual(g.map((x) => x.channel), ["head_tilt"]);
});

test("mapCues preserves cue order", () => {
  const g = mapCues([cue("hold", 100), cue("backchannel", 500), cue("turn_take", 900)]);
  const times = g.map((x) => x.at);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(times[0], 100);
  assert.equal(times[times.length - 1], 900);
});