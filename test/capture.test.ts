import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CaptureError,
  FfmpegCapture,
  WavFileCapture,
  defaultCaptureBackend,
  ffmpegListArgs,
  ffmpegRecordArgs,
  parseArecordDevices,
  parseAvfoundationDevices,
  parseDshowDevices,
  parsePactlSources,
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

// The shape ffmpeg 7 prints on macOS: two sections, video first.
const AVFOUNDATION = [
  "[AVFoundation indev @ 0x7f] AVFoundation video devices:",
  "[AVFoundation indev @ 0x7f] [0] FaceTime HD Camera",
  "[AVFoundation indev @ 0x7f] [1] Capture screen 0",
  "[AVFoundation indev @ 0x7f] AVFoundation audio devices:",
  "[AVFoundation indev @ 0x7f] [0] MacBook Pro Microphone",
  "[AVFoundation indev @ 0x7f] [2] BlackHole 2ch",
].join("\n");

test("avfoundation parsing keeps audio indices and drops cameras", () => {
  const devices = parseAvfoundationDevices(AVFOUNDATION);
  // Indices are what ffmpeg wants on -i, and they do not restart at zero:
  // renumbering them here would silently record the camera.
  assert.deepEqual(devices, [
    { name: "0", alternative: "MacBook Pro Microphone" },
    { name: "2", alternative: "BlackHole 2ch" },
  ]);
});

test("avfoundation parsing of an empty listing is empty", () => {
  assert.deepEqual(parseAvfoundationDevices(""), []);
  assert.deepEqual(parseAvfoundationDevices("AVFoundation video devices:\n[0] Cam"), []);
});

test("pactl sources drop monitor loopbacks and keep microphones", () => {
  const text = [
    "0\talsa_output.pci-0000_00_1f.3.analog-stereo.monitor\tmodule-alsa-card.c\ts16le 2ch 48000Hz\tSUSPENDED",
    "1\talsa_input.pci-0000_00_1f.3.analog-stereo\tmodule-alsa-card.c\ts16le 2ch 44100Hz\tRUNNING",
  ].join("\n");
  assert.deepEqual(parsePactlSources(text), [{ name: "alsa_input.pci-0000_00_1f.3.analog-stereo" }]);
  assert.deepEqual(parsePactlSources(""), []);
});

test("arecord cards become hw: names, not card labels", () => {
  const text = [
    "**** List of CAPTURE Hardware Devices ****",
    "card 0: PCH [HDA Intel PCH], device 0: ALC257 Analog [ALC257 Analog]",
    "  Subdevices: 1/1",
    "card 2: Device [USB Audio Device], device 0: USB Audio [USB Audio]",
  ].join("\n");
  assert.deepEqual(parseArecordDevices(text), [
    { name: "hw:0,0", alternative: "ALC257 Analog" },
    { name: "hw:2,0", alternative: "USB Audio" },
  ]);
});

test("the default backend follows the platform", () => {
  assert.equal(defaultCaptureBackend("win32"), "dshow");
  assert.equal(defaultCaptureBackend("darwin"), "avfoundation");
  assert.equal(defaultCaptureBackend("linux"), "pulse");
  assert.equal(defaultCaptureBackend("freebsd"), "pulse", "anything else gets the Linux path");
});

test("recording argv carries every flag whose absence is silent", () => {
  const argv = ffmpegRecordArgs({
    device: "麦克风阵列 (Realtek(R) Audio)",
    sampleRate: 16000,
    outPath: "C:\\tmp\\u.wav",
    maxSeconds: 60,
    backend: "dshow",
  });
  assert.ok(argv.includes("-y"), "without -y ffmpeg keeps yesterday's file");
  assert.ok(argv.includes("-acodec") && argv.includes("pcm_s16le"));
  assert.ok(argv.includes("-ac") && argv.includes("1"), "recognisers expect mono");
  assert.ok(argv.includes("-ar") && argv.includes("16000"));
  assert.ok(argv.includes("-t") && argv.includes("60"), "a forgotten recording must not fill the disk");
  assert.equal(argv[argv.indexOf("-i") + 1], "audio=麦克风阵列 (Realtek(R) Audio)");
  assert.equal(argv[argv.length - 1], "C:\\tmp\\u.wav", "the output path is last");
});

test("only dshow prefixes the device with audio=", () => {
  const base = { device: "1", sampleRate: 16000, outPath: "u.wav", maxSeconds: 10 };
  const av = ffmpegRecordArgs({ ...base, backend: "avfoundation" });
  assert.equal(av[av.indexOf("-f") + 1], "avfoundation");
  assert.equal(av[av.indexOf("-i") + 1], "1", "avfoundation wants a bare index");
  const pulse = ffmpegRecordArgs({ ...base, device: "alsa_input.x", backend: "pulse" });
  assert.equal(pulse[pulse.indexOf("-f") + 1], "pulse");
  assert.equal(pulse[pulse.indexOf("-i") + 1], "alsa_input.x");
  const alsa = ffmpegRecordArgs({ ...base, device: "hw:0,0", backend: "alsa" });
  assert.equal(alsa[alsa.indexOf("-f") + 1], "alsa");
  assert.equal(alsa[alsa.indexOf("-i") + 1], "hw:0,0");
});

test("listing argv exists only where ffmpeg can enumerate", () => {
  assert.ok(ffmpegListArgs("dshow")?.includes("dshow"));
  const av = ffmpegListArgs("avfoundation");
  assert.ok(av && av.includes("avfoundation"));
  assert.equal(av?.[av.length - 1], "", "avfoundation needs an empty -i to list");
  assert.equal(ffmpegListArgs("pulse"), null, "ffmpeg cannot enumerate PulseAudio");
  assert.equal(ffmpegListArgs("alsa"), null, "ffmpeg cannot enumerate ALSA");
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
