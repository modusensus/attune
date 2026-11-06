import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeWav, encodeWav, peakOf, WavError } from "../src/audio/wav.ts";

/** Builds a wav by hand so the decoder is tested against known bytes, not its own encoder. */
function build(opts: {
  format?: number;
  channels?: number;
  sampleRate?: number;
  bits?: number;
  samples: number[];
  extraChunk?: boolean;
  fmtSize?: number;
  truncateData?: number;
}): Uint8Array {
  const format = opts.format ?? 1;
  const channels = opts.channels ?? 1;
  const sampleRate = opts.sampleRate ?? 8000;
  const bits = opts.bits ?? 16;
  // Float samples are always 4 bytes regardless of what the header claims.
  const bytesPerSample = format === 3 ? 4 : Math.ceil(bits / 8);
  const fmtSize = opts.fmtSize ?? (opts.extraChunk ? 18 : 16);
  const dataLen = Math.floor(opts.samples.length * bytesPerSample) - (opts.truncateData ?? 0);
  const dataChunk = 8 + dataLen;
  const fmtChunk = 8 + fmtSize;
  const listChunk = opts.extraChunk ? 12 : 0;
  const total = 12 + fmtChunk + listChunk + dataChunk;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) bytes[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, total - 8, true);
  ascii(8, "WAVE");

  let pos = 12;
  ascii(pos, "fmt ");
  view.setUint32(pos + 4, fmtSize, true);
  view.setUint16(pos + 8, format, true);
  view.setUint16(pos + 10, channels, true);
  view.setUint32(pos + 12, sampleRate, true);
  view.setUint32(pos + 16, sampleRate * channels * bytesPerSample, true);
  view.setUint16(pos + 20, channels * bytesPerSample, true);
  view.setUint16(pos + 22, bits, true);
  if (fmtSize >= 18) view.setUint16(pos + 24, 0, true);
  pos += fmtChunk;

  if (opts.extraChunk) {
    ascii(pos, "LIST");
    view.setUint32(pos + 4, 4, true);
    pos += listChunk;
  }

  ascii(pos, "data");
  view.setUint32(pos + 4, dataLen, true);
  const body = pos + 8;
  for (let i = 0; i < opts.samples.length; i++) {
    const v = opts.samples[i];
    const at = body + i * bytesPerSample;
    if (at + bytesPerSample > body + dataLen) break;
    if (format === 3) view.setFloat32(at, v, true);
    else if (bits === 8) view.setUint8(at, Math.round(v * 128) + 128);
    else if (bits === 16) view.setInt16(at, Math.round(v * 32767), true);
    else if (bits === 24) {
      let n = Math.round(v * 8388607);
      if (n < 0) n += 0x1000000;
      view.setUint8(at, n & 0xff);
      view.setUint8(at + 1, (n >> 8) & 0xff);
      view.setUint8(at + 2, (n >> 16) & 0xff);
    }
    else if (bits === 32) view.setInt32(at, Math.round(v * 2147483647), true);
  }
  return bytes;
}

test("encode then decode round-trips the format and the samples", () => {
  const samples = new Float32Array([0, 0.25, -0.5, 1, -1]);
  const bytes = encodeWav(samples, 22050);
  const audio = decodeWav(bytes);
  assert.equal(audio.sampleRate, 22050);
  assert.equal(audio.channels, 1);
  assert.equal(audio.bitsPerSample, 16);
  assert.equal(audio.format, 1);
  assert.equal(audio.samples.length, samples.length);
  for (let i = 0; i < samples.length; i++) {
    assert.ok(Math.abs(audio.samples[i] - samples[i]) < 0.001, "sample " + i);
  }
  assert.ok(Math.abs(audio.durationMs - (5 / 22050) * 1000) < 0.001);
});

test("a SAPI-style file with an 18-byte fmt chunk and a LIST chunk decodes", () => {
  // This is the exact shape System.Speech writes: fmt size 18 with cbSize, and
  // metadata chunks between fmt and data.
  const audio = decodeWav(build({ samples: [0.5, -0.5], extraChunk: true }));
  assert.equal(audio.samples.length, 2);
  assert.ok(Math.abs(audio.samples[0] - 0.5) < 0.001);
});

test("stereo is downmixed to mono by averaging", () => {
  const audio = decodeWav(build({ channels: 2, samples: [0.8, 0.2, -0.6, -0.2] }));
  assert.equal(audio.channels, 2);
  assert.equal(audio.samples.length, 2);
  assert.ok(Math.abs(audio.samples[0] - 0.5) < 0.001);
  assert.ok(Math.abs(audio.samples[1] + 0.4) < 0.001);
});

test("8-bit, 24-bit and 32-bit PCM all decode to the same scale", () => {
  const eight = decodeWav(build({ bits: 8, samples: [0.5] }));
  assert.ok(Math.abs(eight.samples[0] - 0.5) < 0.01);

  const twentyFour = decodeWav(build({ bits: 24, samples: [0.5] }));
  assert.ok(Math.abs(twentyFour.samples[0] - 0.5) < 0.001);

  const thirtyTwo = decodeWav(build({ bits: 32, samples: [0.5] }));
  assert.ok(Math.abs(thirtyTwo.samples[0] - 0.5) < 0.001);
});

test("32-bit IEEE float decodes", () => {
  const audio = decodeWav(build({ format: 3, bits: 32, samples: [0.123] }));
  assert.equal(audio.format, 3);
  assert.ok(Math.abs(audio.samples[0] - 0.123) < 1e-6);
});

test("a truncated data chunk still yields the audio that survived", () => {
  // Half a sample cut off the end: the decoder must drop it, not fail.
  const audio = decodeWav(build({ samples: [0.1, 0.2, 0.3], truncateData: 1 }));
  assert.equal(audio.samples.length, 2);
});

test("non-PCM encodings are refused rather than decoded as noise", () => {
  // 6 is A-law, 7 is mu-law: common from telephony-ish encoders.
  assert.throws(() => decodeWav(build({ format: 6, samples: [0] })), /unsupported wav format tag 6/);
  assert.throws(() => decodeWav(build({ format: 3, bits: 16, samples: [0] })), /float wav must be 32-bit/);
});

test("a file that is not a wav fails with a reason", () => {
  assert.throws(() => decodeWav(new Uint8Array([1, 2, 3])), WavError);
  assert.throws(() => decodeWav(new Uint8Array(16)), /missing RIFF/);
  const bytes = encodeWav(new Float32Array(2), 8000);
  bytes[8] = 0x58;
  assert.throws(() => decodeWav(bytes), /missing WAVE/);
});

test("a wav with no data chunk fails with a reason", () => {
  const bytes = encodeWav(new Float32Array(0), 8000);
  const view = new DataView(bytes.buffer);
  // Rewrite the data chunk id so the parser never sees it.
  bytes[36] = 0x6a;
  assert.equal(view.getUint32(40, true), 0);
  assert.throws(() => decodeWav(bytes), /no data chunk/);
});

test("peakOf reports the loudest sample", () => {
  assert.ok(Math.abs(peakOf(new Float32Array([0.1, -0.9, 0.4])) - 0.9) < 1e-6);
  assert.equal(peakOf(new Float32Array(0)), 0);
});

test("encodeWav refuses a nonsense sample rate", () => {
  assert.throws(() => encodeWav(new Float32Array(1), 0), /sampleRate must be/);
  assert.throws(() => encodeWav(new Float32Array(1), 8000.5), /sampleRate must be/);
});
