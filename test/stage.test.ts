import assert from "node:assert/strict";
import { test } from "node:test";
import { Stage } from "../src/render/stage.ts";
import { NullBackend } from "../src/render/backend.ts";
import type { Gesture } from "../src/render/gesture.ts";
import type { MouthFrame } from "../src/audio/envelope.ts";

const gesture = (channel: string, at: number, peak = 1): Gesture => ({
  channel,
  at,
  peak,
  riseMs: 100,
  holdMs: 100,
  fallMs: 100,
});

test("a fresh stage is listening with nothing to say", () => {
  const stage = new Stage(new NullBackend());
  assert.equal(stage.currentState, "listening");
  assert.equal(stage.gestureCount, 0);
  assert.equal(stage.mouthAt(0), 0);
  const frame = stage.frameAt(0);
  assert.equal(frame.state, "listening");
  assert.deepEqual(frame.channels, {});
});

test("gestures accumulate and are sampled per gesture, not by order", () => {
  const stage = new Stage(new NullBackend());
  // Given out of order on purpose: reactions arrive whenever the listener
  // decides, and a caller that concatenated two batches must not have to sort.
  stage.addGestures([gesture("nod", 1000), gesture("nod", 200)]);
  assert.equal(stage.gestureCount, 2);
  assert.equal(stage.frameAt(50).channels.nod, undefined);
  assert.ok(stage.frameAt(250).channels.nod > 0, "the earlier nod is under way");
  assert.ok(stage.frameAt(1100).channels.nod > 0, "the later one too");
  assert.equal(stage.frameAt(5000).channels.nod, undefined, "both are over");
});

test("two gestures on one channel do not add up", () => {
  const stage = new Stage(new NullBackend());
  stage.addGestures([gesture("nod", 0, 0.8), gesture("nod", 0, 0.9)]);
  const peak = stage.frameAt(150).channels.nod;
  assert.ok(Math.abs(peak - 0.9) < 1e-9, "one neck, so the louder one wins");
});

test("clearGestures forgets a finished turn", () => {
  const stage = new Stage(new NullBackend());
  stage.addGestures([gesture("nod", 0)]);
  stage.clearGestures();
  assert.equal(stage.gestureCount, 0);
  assert.deepEqual(stage.frameAt(150).channels, {});
});

test("the mouth curve is sorted on the way in", () => {
  const stage = new Stage(new NullBackend());
  const unsorted: MouthFrame[] = [{ at: 100, open: 1 }, { at: 0, open: 0 }, { at: 50, open: 0.5 }];
  stage.setMouth(unsorted);
  assert.equal(stage.mouthAt(0), 0);
  assert.equal(stage.mouthAt(50), 0.5);
  assert.equal(stage.mouthAt(100), 1);
});

test("the mouth is closed before the curve and holds its last value after", () => {
  const stage = new Stage(new NullBackend());
  stage.setMouth([{ at: 100, open: 1 }, { at: 200, open: 0 }]);
  assert.equal(stage.mouthAt(0), 0, "before the first frame nothing is open");
  assert.equal(stage.mouthAt(99), 0);
  assert.equal(stage.mouthAt(500), 0, "the envelope ends closed, so afterwards is closed");
});

test("the mouth interpolates between frames", () => {
  const stage = new Stage(new NullBackend());
  stage.setMouth([{ at: 0, open: 0 }, { at: 100, open: 1 }]);
  assert.ok(Math.abs(stage.mouthAt(50) - 0.5) < 1e-9);
  assert.ok(Math.abs(stage.mouthAt(25) - 0.25) < 1e-9);
  assert.ok(Math.abs(stage.mouthAt(75) - 0.75) < 1e-9);
});

test("the mouth binary search still lands correctly on a long curve", () => {
  const stage = new Stage(new NullBackend());
  const frames: MouthFrame[] = [];
  for (let i = 0; i <= 600; i++) frames.push({ at: i * 16, open: i / 600 });
  stage.setMouth(frames);
  for (const i of [0, 1, 7, 300, 599, 600]) {
    assert.ok(Math.abs(stage.mouthAt(i * 16) - i / 600) < 1e-9, "frame " + i);
  }
});

test("a non-finite mouth time closes the mouth instead of poisoning it", () => {
  const stage = new Stage(new NullBackend());
  stage.setMouth([{ at: 0, open: 0.5 }, { at: 100, open: 1 }]);
  assert.equal(stage.mouthAt(Number.NaN), 0);
  assert.equal(stage.mouthAt(Number.POSITIVE_INFINITY), 1, "infinity is after the end");
});

test("out-of-range mouth values are clamped", () => {
  const stage = new Stage(new NullBackend());
  stage.setMouth([{ at: 0, open: 4 }, { at: 100, open: -3 }]);
  assert.equal(stage.mouthAt(0), 1);
  assert.equal(stage.mouthAt(100), 0);
});

test("a new reply replaces the old curve rather than queueing behind it", () => {
  const stage = new Stage(new NullBackend());
  stage.setMouth([{ at: 0, open: 1 }, { at: 1000, open: 1 }]);
  stage.setMouth([{ at: 0, open: 0.2 }, { at: 100, open: 0 }]);
  assert.ok(Math.abs(stage.mouthAt(0) - 0.2) < 1e-9);
  assert.equal(stage.mouthAt(500), 0, "the old curve does not come back");
});

test("state changes reach the frame and are not inferred from gestures", () => {
  const stage = new Stage(new NullBackend());
  stage.setState("speaking");
  assert.equal(stage.currentState, "speaking");
  assert.equal(stage.frameAt(0).state, "speaking");
  stage.setState("thinking");
  assert.equal(stage.frameAt(0).state, "thinking");
});

test("the stage passes the mouth value through to the backend", () => {
  // A backend that reported what it was handed, so the wiring itself is under
  // test rather than only the backend arithmetic.
  let seen: number | undefined;
  const spy = {
    id: "spy",
    frame(input: { mouth?: number; at: number; state: "listening" | "thinking" | "speaking"; gestures: Gesture[] }) {
      seen = input.mouth;
      return {
        at: input.at,
        state: input.state,
        channels: {},
        bones: {},
        expressions: {},
        parameters: {},
        parametersAssumed: false,
        dropped: [],
      };
    },
  };
  const stage = new Stage(spy);
  stage.setMouth([{ at: 0, open: 0 }, { at: 100, open: 1 }]);
  stage.frameAt(50);
  assert.ok(seen !== undefined && Math.abs(seen - 0.5) < 1e-9);
  stage.frameAt(0);
  assert.equal(seen, 0);
});
