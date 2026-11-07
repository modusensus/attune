import { Buffer } from "node:buffer";

/**
 * WAV decode/encode. M2 needs exactly two things from this file: turn whatever
 * a TTS engine hands back into samples the envelope can measure, and turn
 * samples back into something an ASR endpoint will accept.
 *
 * The decoder is deliberately permissive about the container (SAPI writes a
 * 18-byte fmt chunk with a cbSize extension, other writers emit LIST chunks
 * before data) and deliberately strict about the sample encoding: only PCM and
 * IEEE float are decoded, and everything else fails loudly instead of being
 * silently treated as noise.
 */

export class WavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WavError";
  }
}

export interface WavAudio {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** WAVE format tag after 0xFFFE resolution: 1 = PCM, 3 = IEEE float. */
  format: number;
  /** Mono, downmixed from any channel count, normalized to -1..1. */
  samples: Float32Array;
  durationMs: number;
}

function ascii(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function writeAscii(bytes: Uint8Array, at: number, text: string): void {
  for (let i = 0; i < 4; i++) bytes[at + i] = text.charCodeAt(i);
}

function readSample(view: DataView, at: number, format: number, bits: number): number {
  if (format === 3) return view.getFloat32(at, true);
  if (bits === 8) return (view.getUint8(at) - 128) / 128;
  if (bits === 16) return view.getInt16(at, true) / 32768;
  if (bits === 24) {
    const b0 = view.getUint8(at);
    const b1 = view.getUint8(at + 1);
    const b2 = view.getUint8(at + 2);
    let v = b2 << 16 | b1 << 8 | b0;
    if (v & 0x800000) v -= 0x1000000;
    return v / 8388608;
  }
  if (bits === 32) return view.getInt32(at, true) / 2147483648;
  throw new WavError("unsupported bit depth: " + bits);
}

export function decodeWav(bytes: Uint8Array): WavAudio {
  if (bytes.length < 12) throw new WavError("not a wav file: only " + bytes.length + " bytes");
  if (ascii(bytes, 0) !== "RIFF") throw new WavError("not a wav file: missing RIFF header");
  if (ascii(bytes, 8) !== "WAVE") throw new WavError("not a wav file: missing WAVE marker");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataAt = -1;
  let dataLen = 0;

  while (pos + 8 <= bytes.length) {
    const id = ascii(bytes, pos);
    let size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    // A truncated download or a lying header should still yield whatever audio
    // is actually there rather than a hard failure.
    if (body + size > bytes.length) size = bytes.length - body;

    if (id === "fmt ") {
      if (size < 16) throw new WavError("malformed fmt chunk: " + size + " bytes");
      let format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true);
      if (channels < 1) throw new WavError("malformed fmt chunk: channels = 0");
      if (sampleRate < 1) throw new WavError("malformed fmt chunk: sampleRate = 0");
      fmt = { format, channels, sampleRate, bits };
    } else if (id === "data") {
      dataAt = body;
      dataLen = size;
    }

    pos = body + size + (size & 1);
  }

  if (!fmt) throw new WavError("wav file has no fmt chunk");
  if (dataAt < 0) throw new WavError("wav file has no data chunk");
  if (fmt.format !== 1 && fmt.format !== 3) {
    throw new WavError(
      "unsupported wav format tag " + fmt.format + " (only PCM and IEEE float are decoded)",
    );
  }
  if (fmt.format === 3 && fmt.bits !== 32) {
    throw new WavError("float wav must be 32-bit, got " + fmt.bits);
  }

  const bytesPerSample = Math.ceil(fmt.bits / 8);
  const frameBytes = bytesPerSample * fmt.channels;
  const frames = Math.floor(dataLen / frameBytes);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      sum += readSample(view, dataAt + i * frameBytes + c * bytesPerSample, fmt.format, fmt.bits);
    }
    samples[i] = sum / fmt.channels;
  }

  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bits,
    format: fmt.format,
    samples,
    durationMs: (frames / fmt.sampleRate) * 1000,
  };
}

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate < 1) {
    throw new WavError("sampleRate must be a positive integer, got " + sampleRate);
  }
  const n = samples.length;
  const bytes = new Uint8Array(44 + n * 2);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return bytes;
}

/** Resample by linear interpolation. Used to feed models a fixed 16 kHz. */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  if (!(from > 0) || !(to > 0)) throw new WavError("resample needs positive rates, got " + from + " -> " + to);
  const n = Math.max(1, Math.round((samples.length * to) / from));
  const out = new Float32Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

/** Peak absolute amplitude of the whole buffer, used to tell silence from speech. */
export function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

export function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
