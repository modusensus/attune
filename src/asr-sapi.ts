import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav, resample, type WavAudio } from "./audio/wav.ts";
import { asrFromConfig, AsrError, type AsrConfig, type AsrProvider, type Transcript } from "./asr.ts";

/**
 * Windows' own dictation recogniser, through System.Speech.
 *
 * It is here for the same reason SapiSpeech is here: on a stock Windows box it is
 * the only ear that needs no download, no Python, and no model file. It is also
 * genuinely mediocre - it is the Windows 7-era engine, it mishears ordinary
 * Mandarin, and its confidence number is closer to a vibe than a probability. The
 * README says so, and the acceptance script reports the character overlap rather
 * than pretending it is exact.
 *
 * So: usable, not good. Anyone who cares will point [asr] at a whisper endpoint or
 * a whisper.cpp binary, which is why those two exist.
 */

const SAPI_ASR_SCRIPT = [
  "param([string]$WavPath, [string]$OutPath, [string]$Language)",
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Speech",
  "",
  "$culture = $null",
  "if ($Language -ne '') {",
  "  try { $culture = [System.Globalization.CultureInfo]::GetCultureInfo($Language) } catch { $culture = $null }",
  "}",
  "if ($culture -eq $null) {",
  "  foreach ($r in [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()) {",
  "    if ($r.Culture.Name.StartsWith('zh')) { $culture = $r.Culture; break }",
  "  }",
  "}",
  "if ($culture -eq $null) {",
  "  $all = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()",
  "  if ($all.Count -eq 0) { throw 'no speech recognizer is installed on this machine' }",
  "  $culture = $all[0].Culture",
  "}",
  "",
  "$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine -ArgumentList $culture",
  "try {",
  "  $rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))",
  "  $rec.SetInputToWaveFile($WavPath)",
  "  $parts = New-Object System.Collections.ArrayList",
  "  $confs = New-Object System.Collections.ArrayList",
  "  # Recognize() throws once the file is exhausted; that is the normal exit.",
  "  for ($i = 0; $i -lt 200; $i++) {",
  "    try { $r = $rec.Recognize() } catch { break }",
  "    if ($r -eq $null) { break }",
  "    [void]$parts.Add($r.Text)",
  "    [void]$confs.Add([double]$r.Confidence)",
  "  }",
  "  $text = ($parts -join '')",
  "  $conf = 0.0",
  "  if ($confs.Count -gt 0) {",
  "    $sum = 0.0",
  "    foreach ($c in $confs) { $sum += $c }",
  "    $conf = $sum / $confs.Count",
  "  }",
  "  $payload = [ordered]@{ text = $text; confidence = $conf; language = $culture.Name; segments = $parts.Count }",
  "  $json = ConvertTo-Json -InputObject $payload -Compress",
  "  [System.IO.File]::WriteAllText($OutPath, $json, (New-Object System.Text.UTF8Encoding($false)))",
  "} finally {",
  "  $rec.Dispose()",
  "}",
].join("\n");

export interface SapiAsrOptions {
  /** BCP-47 culture, e.g. "zh-CN". Empty = first installed, preferring Chinese. */
  language?: string;
  timeoutMs?: number;
}

/** SAPI's recogniser wants 16 kHz mono PCM; anything else is resampled first. */
const SAPI_RATE = 16000;

export class SapiAsr implements AsrProvider {
  readonly id = "sapi";
  private readonly opts: Required<SapiAsrOptions>;

  constructor(options: SapiAsrOptions = {}) {
    this.opts = {
      language: options.language ?? "",
      timeoutMs: options.timeoutMs ?? 120000,
    };
  }

  async transcribe(audio: WavAudio, signal?: AbortSignal): Promise<Transcript> {
    if (process.platform !== "win32") {
      throw new AsrError("the sapi engine only runs on Windows; use engine = \"http\" or \"cli\"");
    }
    if (audio.samples.length === 0) throw new AsrError("nothing to recognise: the audio is empty");

    const mono16k = resample(audio.samples, audio.sampleRate, SAPI_RATE);
    const dir = await mkdtemp(join(tmpdir(), "attune-asr-sapi-"));
    const wavPath = join(dir, "in.wav");
    const outPath = join(dir, "out.json");
    const scriptPath = join(dir, "asr.ps1");
    try {
      await writeFile(wavPath, encodeWav(mono16k, SAPI_RATE));
      await writeFile(scriptPath, SAPI_ASR_SCRIPT, "utf8");
      await runPowerShell(scriptPath, [wavPath, outPath, this.opts.language], this.opts.timeoutMs, signal);

      let raw: string;
      try {
        raw = await readFile(outPath, "utf8");
      } catch {
        throw new AsrError("sapi produced no transcript file (language " + (this.opts.language || "auto") + ")");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new AsrError("sapi wrote malformed JSON: " + raw.slice(0, 200));
      }
      if (typeof parsed !== "object" || parsed === null) {
        throw new AsrError("sapi wrote JSON that is not an object");
      }
      const record = parsed as Record<string, unknown>;
      const text = typeof record.text === "string" ? record.text.trim() : "";
      const transcript: Transcript = { engine: this.id, text, durationMs: audio.durationMs };
      if (typeof record.confidence === "number") transcript.confidence = record.confidence;
      if (typeof record.language === "string") transcript.language = record.language;
      return transcript;
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
      reject(new AsrError("sapi recognition timed out after " + timeoutMs + "ms"));
    }, timeoutMs);
    const onAbort = () => {
      child.kill();
      reject(new AsrError("sapi recognition aborted"));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new AsrError("cannot start powershell: " + err.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (code === 0) resolve();
      else reject(new AsrError("sapi exited with code " + code + (stderr ? ": " + stderr.trim().slice(0, 300) : "")));
    });
  });
}

/**
 * The full seam: [asr] block + environment -> a provider. Kept here rather than
 * in asr.ts so that the Windows-only recogniser is the only thing that has to be
 * conditionally interesting about the platform.
 */
export function asrFromConfigWithSapi(
  config: AsrConfig,
  env: Record<string, string | undefined>,
): AsrProvider {
  const engine = (config.engine ?? "none").trim();
  if (engine === "sapi") {
    return new SapiAsr({ language: config.language, timeoutMs: config.timeoutMs });
  }
  return asrFromConfig(config, env);
}
