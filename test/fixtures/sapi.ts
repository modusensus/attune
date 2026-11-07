import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * SAPI is present on every Windows install and useless on some of them.
 *
 * The runner image is the case that matters: it lists voices (so a platform
 * check says "go ahead") but `SetOutputToWaveFile` writes a zero-byte payload,
 * and every integration test then fails with "sapi produced an empty wav file"
 * - a message that accuses the synthesizer of a bug while the real cause is a
 * bare box with no audio voice actually usable.
 *
 * So the probe asks the only question that matters: does a short word come out
 * as audio? Listing is not evidence; a wav with samples in it is.
 */
const VOICES_SCRIPT = [
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {",
  "  $_.VoiceInfo.Name + [char]9 + $_.VoiceInfo.Culture.Name",
  "}",
  "$s.Dispose()",
].join("; ")

function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

function listVoices(): { name: string; culture: string }[] {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", VOICES_SCRIPT], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
  const lines = (r.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.map((l) => {
    const i = l.indexOf("\t");
    return i < 0 ? { name: l, culture: "" } : { name: l.slice(0, i), culture: l.slice(i + 1) };
  }).filter((v) => v.name.length > 0);
}

function canSynthesize(voice: string): { ok: boolean; detail: string } {
  const dir = mkdtempSync(join(tmpdir(), "attune-sapi-"));
  const out = join(dir, "probe.wav");
  try {
    // `-Command` cannot take a leading `param(...)` plus positional args, so the
    // two values go in as single-quoted literals - the only quoting PowerShell
    // never reinterprets.
    const script = [
      "$Out = " + psQuote(out),
      "$Voice = " + psQuote(voice),
      "Add-Type -AssemblyName System.Speech",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "try { $s.SelectVoice($Voice) } catch { }",
      "$s.SetOutputToWaveFile($Out)",
      // Speak(char) has no overload; widen the char to a string first.
      "$s.Speak([string][char]0x55EF)",
      "$s.Dispose()",
    ].join("; ");
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    });
    let bytes = -1;
    try {
      bytes = readFileSync(out).length;
    } catch {
      bytes = -1;
    }
    // A wav header alone is 44 bytes; anything near that is silence with a cover.
    if (bytes > 1000) return { ok: true, detail: "" };
    const why = (r.stderr ?? "").trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    return {
      ok: false,
      detail:
        bytes < 0
          ? "the SAPI probe produced no wav file" + (why ? ": " + why : "")
          : "the SAPI probe produced only " + bytes + " bytes of audio" + (why ? ": " + why : ""),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function probe(): { voices: string[]; zh: string[]; canSpeak: boolean; detail: string } {
  if (process.platform !== "win32") {
    return { voices: [], zh: [], canSpeak: false, detail: "SAPI only exists on Windows" };
  }
  const listed = listVoices();
  const voices = listed.map((v) => v.name);
  const zh = listed.filter((v) => v.culture.toLowerCase().startsWith("zh")).map((v) => v.name);
  if (voices.length === 0) {
    return { voices, zh, canSpeak: false, detail: "this Windows host has no enabled SAPI voice" };
  }
  const trial = canSynthesize(zh[0] ?? voices[0]);
  return { voices, zh, canSpeak: trial.ok, detail: trial.detail };
}

const PROBE = probe();

export const SAPI_VOICES = PROBE.voices;
/** The auto-selection path promises a zh voice; without one it cannot keep that promise. */
export const SAPI_ZH_VOICES = PROBE.zh;
/** True only if a real short word came back as a wav with samples in it. */
export const HAS_SAPI_VOICE = PROBE.canSpeak;
export const SAPI_GAP = PROBE.canSpeak ? "" : PROBE.detail + ", so synthesis cannot be exercised here";
