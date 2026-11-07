import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav, type WavAudio } from "./audio/wav.ts";

/**
 * The speech-recognition seam, third of four. It has the same shape as the
 * language-model seam and the speech seam: one interface, several engines, and a
 * silent default so a machine with nothing installed still runs.
 *
 * What it does NOT do is produce plausible text when it cannot hear. Empty text
 * is a real answer ("nobody said anything recognisable") and the caller is
 * expected to handle it; a recogniser that invents a sentence would put words in
 * the user's mouth and then store them in the transcript.
 *
 * Recognition is whole-utterance, not streaming. A partial-result seam would have
 * a different shape (an async iterable of hypotheses with revisions), and the
 * engine's input is one finished turn — so inventing the streaming shape now
 * would be a promise nothing keeps.
 */

export interface Transcript {
  /** Engine id, e.g. "http:whisper-1". */
  engine: string;
  /** What was heard. Empty means nothing was heard; it is never invented. */
  text: string;
  /** 0..1 when the recogniser offers one. Never synthesised from thin air. */
  confidence?: number;
  language?: string;
  durationMs: number;
}

export interface AsrProvider {
  readonly id: string;
  transcribe(audio: WavAudio, signal?: AbortSignal): Promise<Transcript>;
}

export class AsrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsrError";
  }
}

/**
 * The honest empty recogniser. It hears nothing and says so, which is exactly
 * what a machine with no model can claim. The CLI prints its id in the banner and
 * refuses to record into it — recording audio for a recogniser that cannot hear
 * is theatre.
 */
export class SilentAsr implements AsrProvider {
  readonly id = "silent";

  async transcribe(audio: WavAudio): Promise<Transcript> {
    return { engine: this.id, text: "", durationMs: audio.durationMs };
  }
}

export interface MultipartFile {
  field: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * A multipart/form-data body, by hand, because the only sizeable dependency this
 * project would otherwise need is a form encoder for one request shape.
 * Exported so the encoding can be asserted byte for byte instead of trusted.
 */
export function multipartBody(
  boundary: string,
  fields: Record<string, string>,
  file: MultipartFile,
): Buffer {
  const parts: Buffer[] = [];
  const text = (s: string) => parts.push(Buffer.from(s, "utf8"));

  for (const [name, value] of Object.entries(fields)) {
    text("--" + boundary + "\r\n");
    text('Content-Disposition: form-data; name="' + name + '"\r\n\r\n');
    text(value + "\r\n");
  }

  text("--" + boundary + "\r\n");
  text('Content-Disposition: form-data; name="' + file.field + '"; filename="' + file.filename + '"\r\n');
  text("Content-Type: " + file.contentType + "\r\n\r\n");
  parts.push(Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength));
  text("\r\n--" + boundary + "--\r\n");

  return Buffer.concat(parts);
}

interface ParsedBody {
  text: string;
  confidence?: number;
  language?: string;
}

/**
 * Read a transcription response.
 *
 * OpenAI-compatible servers answer {"text": "..."}; whisper.cpp answers the same;
 * a few local servers answer plain text. All three are accepted, because the
 * protocol has drifted in the wild and refusing two of them would be pedantry
 * dressed as strictness. An HTML body is refused: that is a web page, not a
 * transcript, and silently storing a login form as the user's sentence is worse
 * than failing.
 */
export function parseTranscriptBody(body: string): ParsedBody {
  const trimmed = body.trim();
  if (!trimmed) throw new AsrError("speech server returned an empty body");
  if (trimmed.startsWith("<")) {
    throw new AsrError("speech server returned HTML instead of a transcript: " + trimmed.slice(0, 120));
  }
  if (trimmed.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw new AsrError("speech server returned malformed JSON: " + trimmed.slice(0, 200));
    }
    if (typeof json !== "object" || json === null) {
      throw new AsrError("speech server returned JSON that is not an object");
    }
    const record = json as Record<string, unknown>;
    if (typeof record.text !== "string") {
      throw new AsrError("speech server returned JSON without a text field: " + trimmed.slice(0, 200));
    }
    const out: ParsedBody = { text: record.text };
    if (typeof record.confidence === "number") out.confidence = record.confidence;
    if (typeof record.language === "string") out.language = record.language;
    return out;
  }
  return { text: trimmed };
}

export interface HttpAsrOptions {
  baseUrl: string;
  model: string;
  language?: string;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * Any endpoint that speaks the OpenAI /audio/transcriptions protocol: whisper.cpp
 * server, faster-whisper-server, LocalAI, FunASR's compatible gateway, or a hosted
 * one. attune ships no model, so this is how a real ear is plugged in.
 */
export class HttpAsr implements AsrProvider {
  readonly id: string;
  private readonly opts: Required<Omit<HttpAsrOptions, "apiKey" | "language">> & {
    apiKey?: string;
    language: string;
  };

  constructor(options: HttpAsrOptions) {
    if (!options.baseUrl) throw new AsrError("baseUrl is required");
    if (!options.model) throw new AsrError("model is required");
    this.opts = {
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
      model: options.model,
      language: options.language ?? "",
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs ?? 60000,
    };
    this.id = "http:" + this.opts.model;
  }

  async transcribe(audio: WavAudio, signal?: AbortSignal): Promise<Transcript> {
    if (audio.samples.length === 0) throw new AsrError("nothing to recognise: the audio is empty");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    const forward = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", forward, { once: true });
    }

    try {
      const boundary = "----attune" + randomSuffix();
      const fields: Record<string, string> = { model: this.opts.model, response_format: "json" };
      if (this.opts.language) fields.language = this.opts.language;
      const body = multipartBody(boundary, fields, {
        field: "file",
        filename: "utterance.wav",
        contentType: "audio/wav",
        bytes: encodeWav(audio.samples, audio.sampleRate),
      });

      const headers: Record<string, string> = {
        "content-type": "multipart/form-data; boundary=" + boundary,
      };
      if (this.opts.apiKey) headers.authorization = "Bearer " + this.opts.apiKey;

      let res: Response;
      try {
        res = await fetch(this.opts.baseUrl + "/audio/transcriptions", {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
      } catch (err) {
        throw new AsrError(
          "cannot reach " + this.opts.baseUrl + " (" + (err as Error).message +
            "). Is the recogniser running, and is ATTUNE_ASR_BASE_URL right?",
        );
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new AsrError("speech server returned HTTP " + res.status + (detail ? ": " + detail.slice(0, 300) : ""));
      }

      const parsed = parseTranscriptBody(await res.text());
      const transcript: Transcript = {
        engine: this.id,
        text: parsed.text.trim(),
        durationMs: audio.durationMs,
      };
      if (parsed.confidence !== undefined) transcript.confidence = parsed.confidence;
      if (parsed.language !== undefined) transcript.language = parsed.language;
      return transcript;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", forward);
    }
  }
}

function randomSuffix(): string {
  let s = "";
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/**
 * Split a command template into argv. Whitespace separates; single or double
 * quotes group. No shell, no globbing, no variable expansion — the template is a
 * config file line, and a config file that can run arbitrary shell would make
 * "character=" a remote code execution surface.
 */
export function splitArgs(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: string | null = null;

  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (started) {
        out.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }

  if (quote) throw new AsrError("unbalanced quote in asr command: " + command);
  if (started) out.push(cur);
  return out;
}

export interface CliAsrOptions {
  /**
   * argv template, e.g. "whisper-cli -m models/ggml-base.bin -nt -f {audio}".
   * Every token containing {audio} gets the temp wav path spliced in, so a path
   * with spaces stays one token.
   */
  command: string;
  timeoutMs?: number;
}

/**
 * An installed command line recogniser: whisper.cpp, sherpa-onnx, vosk, funasr.
 * This is the path for people who already have one, which is most people who
 * would want this — the recogniser is the part everyone already solved.
 *
 * Text comes from stdout. A tool that only writes a file is not supported here;
 * wrap it in a one-line script that cats the file, rather than teaching this
 * class every tool's flags.
 */
export class CliAsr implements AsrProvider {
  readonly id: string;
  private readonly argv: string[];
  private readonly timeoutMs: number;

  constructor(options: CliAsrOptions) {
    if (!options.command || !options.command.trim()) throw new AsrError("asr command is empty");
    const argv = splitArgs(options.command);
    if (argv.length === 0) throw new AsrError("asr command is empty");
    if (!argv.some((token) => token.includes("{audio}"))) {
      throw new AsrError('asr command needs an {audio} placeholder, e.g. "whisper-cli -f {audio}"');
    }
    this.argv = argv;
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.id = "cli:" + basename(argv[0]);
  }

  async transcribe(audio: WavAudio, signal?: AbortSignal): Promise<Transcript> {
    if (audio.samples.length === 0) throw new AsrError("nothing to recognise: the audio is empty");

    const dir = await mkdtemp(join(tmpdir(), "attune-asr-"));
    const audioPath = join(dir, "utterance.wav");
    try {
      await writeFile(audioPath, encodeWav(audio.samples, audio.sampleRate));
      const argv = this.argv.map((token) => token.split("{audio}").join(audioPath));
      const stdout = await run(argv, this.timeoutMs, signal);
      return { engine: this.id, text: stdout.trim(), durationMs: audio.durationMs };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function run(argv: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      if (stdout.length < 100000) stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      if (stderr.length < 4000) stderr += c.toString("utf8");
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new AsrError("asr command timed out after " + timeoutMs + "ms"));
    }, timeoutMs);
    const onAbort = () => {
      child.kill();
      reject(new AsrError("asr command aborted"));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new AsrError("cannot start " + argv[0] + ": " + err.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new AsrError(
          "asr command exited with code " + code + (stderr ? ": " + stderr.trim().slice(0, 300) : ""),
        ),
      );
    });
  });
}

export interface AsrConfig {
  engine?: string;
  model?: string;
  language?: string;
  command?: string;
  timeoutMs?: number;
}

/**
 * Reads the character's [asr] block and the environment once, at the edge.
 * Unknown engines are an error, not a silent fallback: a typo in a config file
 * should be visible immediately, not at the first sentence that never arrives.
 */
export function asrFromConfig(config: AsrConfig, env: Record<string, string | undefined>): AsrProvider {
  const engine = (config.engine ?? "none").trim();
  if (engine === "none" || engine === "silent") return new SilentAsr();

  if (engine === "http" || engine === "openai" || engine === "whisper") {
    const baseUrl = (env.ATTUNE_ASR_BASE_URL ?? "").trim();
    const model = (config.model && config.model !== "none" ? config.model : (env.ATTUNE_ASR_MODEL ?? "")).trim();
    if (!baseUrl || !model) {
      throw new AsrError("asr engine \"http\" needs ATTUNE_ASR_BASE_URL and a model (asr.model or ATTUNE_ASR_MODEL)");
    }
    const language = (config.language ?? env.ATTUNE_ASR_LANGUAGE ?? "").trim();
    return new HttpAsr({
      baseUrl,
      model,
      language,
      apiKey: env.ATTUNE_ASR_API_KEY?.trim(),
      timeoutMs: config.timeoutMs,
    });
  }

  if (engine === "cli") {
    const command = (config.command ?? env.ATTUNE_ASR_COMMAND ?? "").trim();
    if (!command) {
      throw new AsrError("asr engine \"cli\" needs a command ([asr] command = ... or ATTUNE_ASR_COMMAND)");
    }
    return new CliAsr({ command, timeoutMs: config.timeoutMs });
  }

  throw new AsrError("unknown asr engine: " + engine + " (expected none, silent, http, or cli)");
}

/** True when this provider can actually hear something. Used to avoid theatre. */
export function canHear(provider: AsrProvider): boolean {
  return provider.id !== "silent";
}

/** Re-read a wav that was captured earlier, for replaying a turn offline. */
export async function wavFromFile(path: string): Promise<WavAudio> {
  const { decodeWav } = await import("./audio/wav.ts");
  const bytes = await readFile(path);
  return decodeWav(new Uint8Array(bytes));
}
