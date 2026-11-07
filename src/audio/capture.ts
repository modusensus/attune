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
 * to happen on the three platforms this has to run on. The one thing ffmpeg does
 * differently per platform is the input plugin - dshow on Windows, avfoundation
 * on macOS, PulseAudio or ALSA on Linux - so that choice is a value here rather
 * than a branch buried inside the argument list.
 */

export type CaptureBackend = "dshow" | "avfoundation" | "pulse" | "alsa";

export interface CaptureDevice {
  /** The name to pass to ffmpeg, without any prefix. */
  name: string;
  /**
   * Whatever else identifies the device to a human: dshow's alternative name, an
   * ALSA card description - or, on macOS, the label shown in System Settings,
   * because avfoundation addresses devices by index and the index is the name.
   */
  alternative?: string;
}

/**
 * Which input plugin ffmpeg needs on this platform.
 *
 * Chosen from the platform rather than probed. Probing would mean spawning ffmpeg
 * before every recording to see which plugin answers, and a wrong guess is not
 * silent here: ffmpeg says `Unknown input format: 'pulse'` and the recording fails
 * at open time with that sentence attached.
 */
export function defaultCaptureBackend(platform: string = process.platform): CaptureBackend {
  if (platform === "win32") return "dshow";
  if (platform === "darwin") return "avfoundation";
  return "pulse";
}

/**
 * Parse the device listing ffmpeg prints to stderr for DirectShow.
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

/**
 * Parse the AVFoundation listing.
 *
 * Two sections, each a list of `[index] Label` lines, and only the audio section
 * counts - the same rule as dshow, for the same reason. The index is what ffmpeg
 * wants (`-i 1`), the label is what a person recognises, so the index goes in
 * `name` and the label in `alternative`.
 */
export function parseAvfoundationDevices(stderr: string): CaptureDevice[] {
  const devices: CaptureDevice[] = [];
  let inAudio = false;
  for (const raw of stderr.split(/\r?\n/)) {
    if (/AVFoundation audio devices/i.test(raw)) {
      inAudio = true;
      continue;
    }
    if (/AVFoundation video devices/i.test(raw)) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    const line = raw.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (line) devices.push({ name: line[1], alternative: line[2] });
  }
  return devices;
}

/**
 * Parse `pactl list short sources`.
 *
 * Columns are tab-separated: index, name, driver, format, state. Names ending in
 * `.monitor` are outputs being looped back, not microphones - recording one gives
 * you the speakers, which is a real thing to want and not what /talk is for.
 */
export function parsePactlSources(text: string): CaptureDevice[] {
  const devices: CaptureDevice[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(/\t+/);
    if (cols.length < 2) continue;
    const name = cols[1].trim();
    if (!name || name.endsWith(".monitor")) continue;
    devices.push({ name });
  }
  return devices;
}

/**
 * Parse `arecord -l`, the fallback when PulseAudio is not what is running.
 *
 *   card 0: PCH [HDA Intel PCH], device 0: ALC257 Analog [ALC257 Analog]
 *   -> hw:0,0
 *
 * `hw:` is used rather than `plughw:` because ffmpeg resamples anyway; the plug
 * layer would only add a second opinion about the sample rate.
 */
export function parseArecordDevices(text: string): CaptureDevice[] {
  const devices: CaptureDevice[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^card\s+(\d+):\s+.*?device\s+(\d+):\s*(.+?)\s*$/);
    if (!m) continue;
    // arecord prints "ALC257 Analog [ALC257 Analog]": the label, then the same
    // words again in brackets. Keeping both makes the alias twice as long and no
    // more informative, so the duplicate tail goes.
    const label = m[3].replace(/\s*\[[^\]]*\]\s*$/, "").trim();
    devices.push({ name: "hw:" + m[1] + "," + m[2], alternative: label || m[3] });
  }
  return devices;
}

export interface FfmpegArgsOptions {
  device: string;
  sampleRate: number;
  outPath: string;
  maxSeconds: number;
  ffmpeg?: string;
  /** Input plugin. Defaults to the one this platform uses. */
  backend?: CaptureBackend;
}

/**
 * argv for one recording. Exported because the arguments are the part that is
 * easy to get subtly wrong - a missing -y silently keeps yesterday's file - and a
 * test can assert them without spawning anything.
 */
export function ffmpegRecordArgs(opts: FfmpegArgsOptions): string[] {
  const backend = opts.backend ?? defaultCaptureBackend();
  const input = backend === "dshow" ? "audio=" + opts.device : opts.device;
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-nostats",
    "-y",
    "-f", backend,
    "-i", input,
    "-ac", "1",
    "-ar", String(opts.sampleRate),
    "-t", String(opts.maxSeconds),
    "-acodec", "pcm_s16le",
    opts.outPath,
  ];
}

/**
 * argv that makes ffmpeg print a device listing to stderr, or null where it
 * cannot: ffmpeg has no way to enumerate ALSA or PulseAudio devices, so Linux
 * goes through pactl or arecord instead.
 */
export function ffmpegListArgs(backend: CaptureBackend): string[] | null {
  if (backend === "dshow") return ["-hide_banner", "-f", "dshow", "-list_devices", "true", "-i", "dummy"];
  if (backend === "avfoundation") return ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""];
  return null;
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
  /**
   * Device name. On Windows and Linux this is the plain name pactl or dshow
   * printed; on macOS it is the index avfoundation printed. Omit to use the
   * first audio device found.
   */
  device?: string;
  sampleRate?: number;
  /** Safety net so a forgotten recording cannot fill the disk. Default 60s. */
  maxSeconds?: number;
  ffmpeg?: string;
  /** Override the platform default. Rarely needed; exists for tests and odd boxes. */
  backend?: CaptureBackend;
}

/**
 * Microphone capture through ffmpeg.
 *
 * Stopping is done by writing the quit key to ffmpeg's stdin rather than killing
 * it: a killed ffmpeg leaves a wav whose header still claims the full length, and
 * the decoder would then read a truncated file as if it were complete.
 */
export class FfmpegCapture implements Capture {
  readonly id = "ffmpeg";
  readonly backend: CaptureBackend;
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
      backend: options.backend ?? defaultCaptureBackend(),
    };
    this.backend = this.opts.backend;
  }

  /** Audio input devices this platform can see. Throws when nothing answers. */
  async listDevices(): Promise<CaptureDevice[]> {
    const backend = this.opts.backend;
    const argv = ffmpegListArgs(backend);
    const found = argv ? this.fromFfmpeg(backend, argv) : this.fromLinuxTools(backend);
    const devices = await found;
    if (devices.length === 0) {
      throw new CaptureError(
        "no audio input device was found (" + backend + "); is a microphone connected and allowed?",
      );
    }
    return devices;
  }

  private async fromFfmpeg(backend: CaptureBackend, argv: string[]): Promise<CaptureDevice[]> {
    const stderr = await runForText(this.opts.ffmpeg, argv);
    return backend === "dshow" ? parseDshowDevices(stderr) : parseAvfoundationDevices(stderr);
  }

  private async fromLinuxTools(backend: CaptureBackend): Promise<CaptureDevice[]> {
    if (backend === "pulse") {
      const list = await tryRun("pactl", ["list", "short", "sources"]);
      const sources = list === null ? [] : parsePactlSources(list);
      if (sources.length > 0) return sources;
    }
    const cards = await tryRun("arecord", ["-l"]);
    if (cards !== null) {
      const devices = parseArecordDevices(cards);
      if (devices.length > 0) return devices;
    }
    throw new CaptureError(
      "cannot list audio devices: neither pactl nor arecord answered. " +
        "Install pulseaudio-utils or alsa-utils, or pass a device name explicitly.",
    );
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
      backend: this.opts.backend,
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

/** Run a command for its combined output, resolving empty when it cannot start. */
function runForText(cmd: string, argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let text = "";
    child.stderr?.on("data", (c: Buffer) => {
      if (text.length < 200000) text += c.toString("utf8");
    });
    child.on("error", (err) => reject(new CaptureError("cannot start " + cmd + ": " + err.message)));
    child.on("close", () => resolve(text));
  });
}

/**
 * Run a listing tool. Null means "the tool is not installed", which is a normal
 * thing on a minimal container and not worth an exception of its own. A tool that
 * runs and prints nothing also counts as nothing found.
 */
function tryRun(cmd: string, argv: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let text = "";
    const collect = (c: Buffer) => {
      if (text.length < 200000) text += c.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(text));
  });
}
