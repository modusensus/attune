import { test } from "node:test";
import assert from "node:assert/strict";
import { envelopeStats, mouthFrames, rmsWindows } from "../src/audio/envelope.ts";
import type { WavAudio } from "../src/audio/wav.ts";

const RATE = 8000;

/** One mono clip built from a list of segments, so a test can say what it means. */
function clip(segments: { ms: number; amp: number; freq?: number }[]): WavAudio {
  const total = segments.reduce((n, s) => n + Math.round((s.ms / 1000) * RATE), 0);
  const samples = new Float32Array(total);
  let at = 0;
  for (const seg of segments) {
    const n = Math.round((seg.ms / 1000) * RATE);
    const freq = seg.freq ?? 220;
    for (let i = 0; i < n; i++) {
      samples[at + i] = seg.amp === 0 ? 0 : Math.sin((2 * Math.PI * freq * i) / RATE) * seg.amp;
    }
    at += n;
  }
  return {
    sampleRate: RATE,
    channels: 1,
    bitsPerSample: 16,
    format: 1,
    samples,
    durationMs: (total / RATE) * 1000,
  };
}

/** The frame count the implementation promises: one per full window. */
function frameCount(audio: WavAudio, fps: number): number {
  return Math.floor(audio.samples.length / Math.max(1, Math.round(audio.sampleRate / fps)));
}

test("RMS windows have one value per frame and match the window count", () => {
  const audio = clip([{ ms: 100, amp: 0 }, { ms: 100, amp: 0.5 }, { ms: 100, amp: 0 }]);
  const values = rmsWindows(audio.samples, audio.sampleRate, 20);
  assert.equal(values.length, 6);
  assert.equal(values[0], 0, "silence is exactly zero, not noise");
  assert.ok(Math.abs(values[2] - 0.5 / Math.SQRT2) < 0.02, "rms " + values[2]);
});

test("silence produces an all-zero curve rather than NaN", () => {
  const frames = mouthFrames(clip([{ ms: 400, amp: 0 }]), { fps: 20 });
  assert.ok(frames.length > 0);
  for (const f of frames) assert.equal(f.open, 0);
});

test("an empty clip produces no frames at all", () => {
  assert.deepEqual(mouthFrames(clip([]), { fps: 20 }), []);
});

test("the mouth opens during speech and shuts after a long enough pause", () => {
  const audio = clip([{ ms: 400, amp: 0 }, { ms: 600, amp: 0.6 }, { ms: 1200, amp: 0 }]);
  const frames = mouthFrames(audio, { fps: 20 });
  assert.equal(frames.length, frameCount(audio, 20));

  // 400ms lead at 20fps = 8 silent frames; 600ms of speech = frames 8..19.
  assert.equal(frames[0].open, 0, "before the burst");
  for (const f of frames.slice(10, 18)) assert.ok(f.open > 0.6, "frame " + f.at + " open " + f.open);
  assert.ok(frames[frames.length - 1].open < 0.1, "1.2s after the burst the mouth is shut again");
});

test("release lingers longer than attack snaps, which is what a mouth does", () => {
  const audio = clip([{ ms: 200, amp: 0 }, { ms: 200, amp: 1 }, { ms: 1200, amp: 0 }]);
  const frames = mouthFrames(audio, { fps: 20 });
  // 200ms lead = frames 0..3; burst = frames 4..7; release starts at frame 8.
  assert.ok(frames[7].open > 0.75, "after 200ms of speech: " + frames[7].open);
  assert.ok(frames[10].open > 0.3, "100ms after the burst it should still be partly open: " + frames[10].open);
  assert.ok(frames[10].open < frames[7].open, "and it must be falling");
  assert.ok(frames[frames.length - 1].open < 0.1, "1.2s later it is shut");
});

test("every open value stays inside 0..1 and is rounded to 3 decimals", () => {
  const frames = mouthFrames(clip([{ ms: 100, amp: 0 }, { ms: 300, amp: 3 }, { ms: 100, amp: 0 }]), {
    fps: 30,
    gain: 3,
  });
  for (const f of frames) {
    assert.ok(f.open >= 0 && f.open <= 1, "open " + f.open);
    assert.equal(Math.round(f.open * 1000) / 1000, f.open, "not rounded: " + f.open);
  }
});

test("the noise floor drops quiet passages below a loud peak", () => {
  // A loud phrase followed by a whisper at 5% of its level: with a floor at half
  // the peak the whisper is treated as room tone, without one it is not. The
  // release curve needs a second or so to settle, so the check looks at the tail.
  const audio = clip([{ ms: 200, amp: 1 }, { ms: 2000, amp: 0.05 }]);
  const floored = mouthFrames(audio, { fps: 20, noiseFloor: 0.5 });
  const raw = mouthFrames(audio, { fps: 20, noiseFloor: 0 });
  // The floor zeroes the target; the release curve still has to decay, so the
  // assertion is on where it lands, not on the first frame after the loud part.
  assert.equal(floored[floored.length - 1].open, 0, "floored whisper never settled to zero");
  assert.ok(raw[raw.length - 1].open > 0.05, "without a floor the whisper stays audible");
});

test("fps is clamped instead of producing absurd frame counts", () => {
  const audio = clip([{ ms: 500, amp: 0 }]);
  // 500ms at 500 fps would be 250 frames; clamped to 120 it is one per 67 samples.
  assert.equal(mouthFrames(audio, { fps: 500 }).length, frameCount(audio, 120));
  // 500ms at 1 fps would be 0 frames; clamped to 10 it is one per 800 samples.
  assert.equal(mouthFrames(audio, { fps: 1 }).length, frameCount(audio, 10));
});

test("frame timestamps follow the requested frame rate", () => {
  const frames = mouthFrames(clip([{ ms: 300, amp: 0 }]), { fps: 20 });
  assert.equal(frames.length, 6);
  assert.deepEqual(frames.map((f) => f.at), [0, 50, 100, 150, 200, 250]);
});

test("envelopeStats summarises the curve", () => {
  const audio = clip([{ ms: 400, amp: 0 }, { ms: 800, amp: 0.6 }, { ms: 400, amp: 0 }]);
  const frames = mouthFrames(audio, { fps: 20 });
  const stats = envelopeStats(frames, audio.durationMs);
  assert.equal(stats.frames, frameCount(audio, 20));
  assert.equal(stats.durationMs, 1600);
  assert.ok(stats.voicedFrames > 20 && stats.voicedFrames < 40, "voiced " + stats.voicedFrames);
  assert.ok(stats.peakOpen > 0.8 && stats.peakOpen <= 1);
  assert.ok(stats.speechRatio > 0.4 && stats.speechRatio < 0.8, "ratio " + stats.speechRatio);
});

test("an empty frame list has a zero speech ratio instead of dividing by zero", () => {
  const stats = envelopeStats([], 0);
  assert.equal(stats.frames, 0);
  assert.equal(stats.speechRatio, 0);
  assert.equal(stats.peakOpen, 0);
});
