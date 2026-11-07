import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CaptureError,
  FfmpegCapture,
  WavFileCapture,
  ffmpegRecordArgs,
  parseDshowDevices,
} from "../src/audio/capture.ts";
import { encodeWav } from "../src/audio/wav.ts";

// Captured from ffmpeg 9.0.2 on a Windows box, video device included, because the
// thing worth asserting is that the camera is skipped and the microphone is not.
const REAL_STDERR = [
  "[dshow @ 000001e8] \"麦克风阵列 (Realtek(R) Audio)\" (audio)",
  "[dshow @ 000001e8]   Alternative name \"@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{B68AD444-36EC-4D89-BC79-A38D19D1C1}\"",
  "[dshow @ 000001e8] \"HD WebCam\" (video)",
  "[dshow @ 000001e8]   Alternative name \"@device_pnp_\\\\?\\usb#vid_1234&pid_5678#...\"",
  "[dshow @ 000001e8] Could not enumerate video devices (or none found).",
].join("\r\n");

test("dshow device parsing keeps microphones and drops cameras", () => {
  const devices = parseDshowDevices(REAL_STDERR);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, "麦克风阵列 (Realtek(R) Audio)");
  assert.ok(devices[0].alternative?.includes("{B68AD444-36EC-4D89-BC79-A38D19D1C1}"));
});

test("dshow parsing of an empty listing is empty, not a made-up device", () => {
  assert.deepEqual(parseDshowDevices(""), []);
  assert.deepEqual(parseDshowDevices("[dshow] Could not enumerate video devices"), []);
});

test("recording argv carries every flag whose absence is silent", () => {
  const argv = ffmpegRecordArgs({
    device: "麦克风阵列 (Realtek(R) Audio)",
    sampleRate: 16000,
    outPath: "C:\\tmp\\u.wav",
    maxSeconds: 60,
  });
  assert.ok(argv.includes("-y"), "without -y ffmpeg keeps yesterday's file");
  assert.ok(argv.includes("-acodec") && argv.includes("pcm_s16le"));
  assert.ok(argv.includes("-ac") && argv.includes("1"), "recognisers expect mono");
  assert.ok(argv.includes("-ar") && argv.includes("16000"));
  assert.ok(argv.includes("-t") && argv.includes("60"), "a forgotten recording must not fill the disk");
  assert.equal(argv[argv.indexOf("-i") + 1], "audio=麦克风阵列 (Realtek(R) Audio)");
  assert.equal(argv[argv.length - 1], "C:\\tmp\\u.wav", "the output path is last");
});

test("stopping without starting is an error, not an empty recording", async () => {
  const cap = new FfmpegCapture();
  await assert.rejects(() => cap.stop(), /not recording/);
  await cap.abort();
});

test("a file capture gives back exactly the wav it was handed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attune-capture-test-"));
  const path = join(dir, "in.wav");
  const samples = new Float32Array(1600);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.5;
  await writeFile(path, encodeWav(samples, 16000));
  try {
    const cap = new WavFileCapture(path);
    assert.equal(cap.id, "file");
    await cap.start();
    const audio = await cap.stop();
    assert.equal(audio.sampleRate, 16000);
    assert.equal(audio.samples.length, 1600);
    assert.equal(audio.durationMs, 100);
    await assert.rejects(() => cap.start(), CaptureError, "a capture is used once");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a file capture that cannot be read fails loudly", async () => {
  const cap = new WavFileCapture("C:\\definitely\\not\\here.wav");
  await cap.start();
  await assert.rejects(() => cap.stop(), /ENOENT/);
});
