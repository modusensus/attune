import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeWav, encodeWav, type WavAudio } from "./audio/wav.ts";

/**
 * The speech seam. Same shape as the language-model seam: one interface, several
 * engines, and a silent fallback so that a machine with no speech engine still
 * runs the loop end to end.
 *
 * Every engine returns decoded mono audio, because the only consumer of speech
 * in M2 is the mouth envelope, and it does not want to know what made the sound.
 */

export interface SpeechClip {
  /** Engine id, e.g. "sapi" or "http:tts-1". */
  engine: string;
  /** The text this audio speaks. */
  text: string;
  audio: WavAudio;
}

export interface SpeechProvider {
  readonly id: string;
  speak(text: string, signal?: AbortSignal): Promise<SpeechClip>;
}

export class SpeechError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechError";
  }
}

/**
 * Silent engine. It produces real, correctly-timed, all-zero audio rather than
 * nothing at all, so that the speaking state still has a duration to occupy and
 * a renderer still gets a frame list. Duration is estimated from text length
 * because nothing was actually spoken.
 */
export class SilentSpeech implements SpeechProvider {
  readonly id = "silent";
  private readonly msPerChar: number;

  constructor(msPerChar = 220) {
    this.msPerChar = msPerChar;
  }

  async speak(text: string): Promise<SpeechClip> {
    const trimmed = text.trim();
    if (!trimmed) throw new SpeechError("nothing to say: empty text");
    const chars = Array.from(trimmed).length;
    const durationMs = Math.max(400, Math.min(20000, Math.round(chars * this.msPerChar)));
    const sampleRate = 22050;
    const frames = Math.round((durationMs / 1000) * sampleRate);
    const audio = decodeWav(encodeWav(new Float32Array(frames), sampleRate));
    return { engine: this.id, text: trimmed, audio };
  }
}

export interface SapiOptions {
  /** Full voice name, e.g. "Microsoft Huihui Desktop". Empty = first zh voice. */
  voice?: string;
  /** -10..10, SAPI's own scale. 0 is normal. */
  rate?: number;
  timeoutMs?: number;
}

const SAPI_SCRIPT = [
  "param([string]$TextPath, [string]$OutPath, [string]$Voice, [int]$Rate)",
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "if ($Voice -ne '') {",
  "  try { $s.SelectVoice($Voice) } catch { }",
  "} else {",
  "  foreach ($v in $s.GetInstalledVoices()) {",
  "    if ($v.Enabled -and $v.VoiceInfo.Culture.Name.StartsWith('zh')) { $s.SelectVoice($v.VoiceInfo.Name); break }",
  "  }",
  "}",
  "$s.Rate = $Rate",
  "$s.SetOutputToWaveFile($OutPath)",
  "try { $s.Speak([System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8)) } finally { $s.Dispose() }",
].join("\n");

/**
 * Windows SAPI. It is the only engine that works on a stock Windows box with
 * zero downloads, which is why it is here; it is not good, and the docs say so.
 * The PowerShell child is given a script file and plain arguments rather than
 * an inline -Command string, so that Chinese text and paths with spaces survive
 * quoting intact.
 */
export class SapiSpeech implements SpeechProvider {
  readonly id = "sapi";
  private readonly opts: Required<SapiOptions>;

  constructor(options: SapiOptions = {}) {
    this.opts = {
      voice: options.voice ?? "",
      rate: options.rate ?? 0,
      timeoutMs: options.timeoutMs ?? 60000,
    };
  }

  async speak(text: string, signal?: AbortSignal): Promise<SpeechClip> {
    const trimmed = text.trim();
    if (!trimmed) throw new SpeechError("nothing to say: empty text");
    if (process.platform !== "win32") {
      throw new SpeechError("the sapi engine only runs on Windows; use engine = \"silent\" or \"http\"");
    }

    const dir = await mkdtemp(join(tmpdir(), "attune-sapi-"));
    const textPath = join(dir, "say.txt");
    const outPath = join(dir, "say.wav");
    const scriptPath = join(dir, "say.ps1");
    try {
      await writeFile(textPath, trimmed, "utf8");
      await writeFile(scriptPath, SAPI_SCRIPT, "utf8");
      await runPowerShell(scriptPath, [textPath, outPath, this.opts.voice, String(this.opts.rate)], this.opts.timeoutMs, signal);

      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(outPath));
      } catch {
        throw new SpeechError("sapi produced no audio file (voice " + (this.opts.voice || "auto") + ")");
      }
      const audio = decodeWav(bytes);
      if (audio.samples.length === 0) throw new SpeechError("sapi produced an empty wav file");
      return { engine: this.id, text: trimmed, audio };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function runPowerShell(scriptPath: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      if (stderr.length < 2000) stderr += c.toString("utf8");
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new SpeechError("sapi timed out after " + timeoutMs + "ms"));
    }, timeoutMs);
    const onAbort = () => {
      child.kill();
      reject(new SpeechError("sapi aborted"));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new SpeechError("cannot start powershell: " + err.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (code === 0) resolve();
      else reject(new SpeechError("sapi exited with code " + code + (stderr ? ": " + stderr.trim().slice(0, 300) : "")));
    });
  });
}

export interface HttpSpeechOptions {
  baseUrl: string;
  model: string;
  voice?: string;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * Any endpoint that speaks the OpenAI /audio/speech protocol: opened locally
 * (GPT-SoVITS' compatible server, LocalAI, Kokoro-FastAPI) or hosted. attune
 * ships no model, so this is how a real voice is plugged in.
 */
export class HttpSpeech implements SpeechProvider {
  readonly id: string;
  private readonly opts: Required<Omit<HttpSpeechOptions, "apiKey">> & { apiKey?: string };

  constructor(options: HttpSpeechOptions) {
    if (!options.baseUrl) throw new SpeechError("baseUrl is required");
    if (!options.model) throw new SpeechError("model is required");
    this.opts = {
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
      model: options.model,
      voice: options.voice ?? "",
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs ?? 60000,
    };
    this.id = "http:" + this.opts.model;
  }

  async speak(text: string, signal?: AbortSignal): Promise<SpeechClip> {
    const trimmed = text.trim();
    if (!trimmed) throw new SpeechError("nothing to say: empty text");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    const forward = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", forward, { once: true });
    }

    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.opts.apiKey) headers.authorization = "Bearer " + this.opts.apiKey;
      const body: Record<string, unknown> = {
        model: this.opts.model,
        input: trimmed,
        response_format: "wav",
      };
      if (this.opts.voice) body.voice = this.opts.voice;

      let res: Response;
      try {
        res = await fetch(this.opts.baseUrl + "/audio/speech", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        throw new SpeechError(
          "cannot reach " + this.opts.baseUrl + " (" + (err as Error).message + "). Is the speech server running?",
        );
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new SpeechError("speech server returned HTTP " + res.status + (detail ? ": " + detail.slice(0, 300) : ""));
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const audio = decodeWav(bytes);
      if (audio.samples.length === 0) throw new SpeechError("speech server returned an empty wav file");
      return { engine: this.id, text: trimmed, audio };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", forward);
    }
  }
}

export interface SpeechConfig {
  engine?: string;
  model?: string;
  voice?: string;
}

/**
 * Reads the character's [voice] block and the environment once, at the edge.
 * Unknown engines are an error, not a silent fallback: a typo in a config file
 * should be visible immediately.
 */
export function speechFromConfig(
  config: SpeechConfig,
  env: Record<string, string | undefined>,
): SpeechProvider {
  const engine = (config.engine ?? "none").trim();
  if (engine === "none" || engine === "silent") return new SilentSpeech();
  if (engine === "sapi") {
    return new SapiSpeech({ voice: config.model && config.model !== "none" ? config.model : config.voice ?? "" });
  }
  if (engine === "http" || engine === "openai") {
    const baseUrl = (env.ATTUNE_TTS_BASE_URL ?? "").trim();
    const model = (config.model && config.model !== "none" ? config.model : (env.ATTUNE_TTS_MODEL ?? "")).trim();
    if (!baseUrl || !model) {
      throw new SpeechError("voice engine \"http\" needs ATTUNE_TTS_BASE_URL and a model (voice.model or ATTUNE_TTS_MODEL)");
    }
    return new HttpSpeech({ baseUrl, model, voice: config.voice, apiKey: env.ATTUNE_TTS_API_KEY?.trim() });
  }
  throw new SpeechError("unknown voice engine: " + engine + " (expected none, silent, sapi, or http)");
}
