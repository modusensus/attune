import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeWav, type WavAudio } from "./wav.ts";

/**
 * Getting a finished utterance into memory, from a microphone or from a file.
 *
 * There is no streaming capture here on purpose. The recogniser seam is
 * whole-utterance, and push-to-talk is the only capture model that needs no voice
 * activity detection to decide where the utterance ended - which matters,
 * because deciding where an utterance ended is the thing this project does with
 * its own judgement and should not hand to a VAD before it has even heard the
 * pitch contour.
 *
 * ffmpeg is used rather than a native binding: it is one process, it already
 * exists on most machines, and a native audio binding is a build failure waiting
 * to happen on the three platforms this has to run on.
 */

export interface CaptureDevice {
  /** The name to pass to ffmpeg, without the audio= prefix. */
  name: string;
  /** dshow's stable alternative name, when it offers one. */
  alternative?: string;
}

/**
 * Parse the device listing ffmpeg prints to stderr.
 *
 * The format has been stable for years: a name line marked "(audio)" followed by
 * an optional alternative-name line. Video devices are skipped - a camera is not
 * an ear.
 */
export function parseDshowDevices(stderr: string): CaptureDevice[] {
  const devices: CaptureDevice[] = [];
  let pending: CaptureDevice | null = null;

  for (const raw of stderr.split(/\r?\n/)) {
    const alt = raw.match(/Alternative name\s+"([^"]+)"/);
    if (alt) {
      if (pending) pending.alternative = alt[1];
      continue;
    }
    const nameLine = raw.match(/"([^"]+)"\s*\((audio|video)\)\s*$/);
    if (!nameLine) continue;
    if (pending) devices.push(pending);
    pending = nameLine[2] === "audio" ? { name: nameLine[1] } : null;
  }
  if (pending) devices.push(pending);
  return devices;
}

export interface FfmpegArgsOptions {
  device: string;
  sampleRate: number;
  outPath: string;
  maxSeconds: number;
  ffmpeg?: string;
}

/**
 * argv for one recording. Exported because the arguments are the part that is
 * easy to get subtly wrong - a missing -y silently keeps yesterday's file - and a
 * test can assert them without spawning anything.
 */
export function ffmpegRecordArgs(opts: FfmpegArgsOptions): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-nostats",
    "-y",
    "-f", "dshow",
    "-i", "audio=" + opts.device,
    "-ac", "1",
    "-ar", String(opts.sampleRate),
    "-t", String(opts.maxSeconds),
    "-acodec", "pcm_s16le",
    opts.outPath,
  ];
}

export interface Capture {
  readonly id: string;
  /** Begin capturing. Resolves once the device is open. */
  start(): Promise<void>;
  /** Stop capturing and hand back what was heard. */
  stop(): Promise<WavAudio>;
  /** Abandon the utterance without producing audio. */
  abort(): Promise<void>;
}

export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

export interface FfmpegCaptureOptions {
  /** Device name or alternative name. Omit to use the first audio device found. */
  device?: string;
  sampleRate?: number;
  /** Safety net so a forgotten recording cannot fill the disk. Default 60s. */
  maxSeconds?: number;
  ffmpeg?: string;
}

/**
 * Microphone capture through ffmpeg's dshow/dsound/avfoundation backend.
 *
 * Stopping is done by writing the quit key to ffmpeg's stdin rather than killing
 * it: a killed ffmpeg leaves a wav whose header still claims the full length, and
 * the decoder would then read a truncated file as if it were complete.
 */
export class FfmpegCapture implements Capture {
  readonly id = "ffmpeg";
  private readonly opts: Required<FfmpegCaptureOptions>;
  private child: ReturnType<typeof spawn> | null = null;
  private dir: string | null = null;
  private outPath: string | null = null;
  private exited: Promise<number | null> | null = null;
  private stderr = "";

  constructor(options: FfmpegCaptureOptions = {}) {
    this.opts = {
      device: options.device ?? "",
      sampleRate: options.sampleRate ?? 16000,
      maxSeconds: options.maxSeconds ?? 60,
      ffmpeg: options.ffmpeg ?? "ffmpeg",
    };
  }

  /** Audio input devices ffmpeg can see. Throws when ffmpeg is not installed. */
  async listDevices(): Promise<CaptureDevice[]> {
    const stderr = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        this.opts.ffmpeg,
        ["-hide_banner", "-f", "dshow", "-list_devices", "true", "-i", "dummy"],
        { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
      );
      let text = "";
      child.stderr?.on("data", (c: Buffer) => {
        if (text.length < 200000) text += c.toString("utf8");
      });
      child.on("error", (err) => reject(new CaptureError("cannot start ffmpeg: " + err.message)));
      child.on("close", () => resolve(text));
    });
    const devices = parseDshowDevices(stderr);
    if (devices.length === 0) {
      throw new CaptureError("ffmpeg found no audio input device (is a microphone connected and allowed?)");
    }
    return devices;
  }

  async start(): Promise<void> {
    if (this.child) throw new CaptureError("already recording");
    const device = this.opts.device || (await this.listDevices())[0].name;

    const dir = await mkdtemp(join(tmpdir(), "attune-rec-"));
    const outPath = join(dir, "utterance.wav");
    const argv = ffmpegRecordArgs({
      device,
      sampleRate: this.opts.sampleRate,
      outPath,
      maxSeconds: this.opts.maxSeconds,
      ffmpeg: this.opts.ffmpeg,
    });

    this.stderr = "";
    const child = spawn(this.opts.ffmpeg, argv, {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.dir = dir;
    this.outPath = outPath;

    child.stderr?.on("data", (c: Buffer) => {
      if (this.stderr.length < 4000) this.stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      this.stderr += "cannot start ffmpeg: " + err.message;
    });
    this.exited = new Promise((resolve) => child.on("close", () => resolve(child.exitCode)));

    // Give the device a moment to open. ffmpeg exits immediately on a bad device
    // name, and reporting that at stop() time would blame the wrong action.
    await new Promise((r) => setTimeout(r, 250));
    if (child.exitCode !== null) {
      const detail = this.stderr.trim();
      await this.cleanup();
      throw new CaptureError(
        "ffmpeg could not open the microphone" + (detail ? ": " + detail.slice(0, 300) : " (exit " + child.exitCode + ")"),
      );
    }
  }

  async stop(): Promise<WavAudio> {
    const child = this.child;
    const outPath = this.outPath;
    const exited = this.exited;
    if (!child || !outPath || !exited) throw new CaptureError("not recording");

    // "q" is ffmpeg's quit key; stdin is a pipe, so it is read as a command.
    child.stdin?.write("q");
    child.stdin?.end();
    const code = await exited;
    this.child = null;

    let bytes: Uint8Array | null = null;
    try {
      bytes = new Uint8Array(await readFile(outPath));
    } catch {
      bytes = null;
    }
    await this.cleanup();

    if (!bytes) {
      throw new CaptureError(
        "recording produced no file" + (this.stderr ? ": " + this.stderr.trim().slice(0, 300) : " (ffmpeg exit " + code + ")"),
      );
    }
    return decodeWav(bytes);
  }

  async abort(): Promise<void> {
    if (this.child) {
      this.child.stdin?.write("q");
      this.child.stdin?.end();
      await this.exited?.catch(() => {});
      this.child = null;
    }
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    const dir = this.dir;
    this.dir = null;
    this.outPath = null;
    this.exited = null;
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A capture that was already recorded: the same interface, no device.
 *
 * This exists so the whole loop can be exercised without a microphone - on a CI
 * box, over a remote session, or by replaying a real recording to compare
 * recognisers. It is a test double that mirrors the live path rather than a
 * second implementation of it.
 */
export class WavFileCapture implements Capture {
  readonly id = "file";
  private readonly path: string;
  private used = false;

  constructor(path: string) {
    this.path = path;
  }

  async start(): Promise<void> {
    if (this.used) throw new CaptureError("this file capture has already been used");
  }

  async stop(): Promise<WavAudio> {
    if (this.used) throw new CaptureError("this file capture has already been used");
    this.used = true;
    const bytes = await readFile(this.path);
    return decodeWav(new Uint8Array(bytes));
  }

  async abort(): Promise<void> {
    this.used = true;
  }
}
