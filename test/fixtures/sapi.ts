import { spawnSync } from "node:child_process";

/**
 * The Windows runner image ships with no SAPI voice, which turns every
 * integration test into an "empty wav file" error that says nothing about the
 * code. Probe once and let the tests say what is actually missing instead of
 * skipping on `process.platform` - a skip that lies about why it skipped is
 * worse than a red test.
 */
const SCRIPT = [
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {",
  "  $_.VoiceInfo.Name + [char]9 + $_.VoiceInfo.Culture.Name",
  "}",
  "$s.Dispose()",
].join("; ")

function probe(): { voices: string[]; zh: string[] } {
  if (process.platform !== "win32") return { voices: [], zh: [] };
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
  const lines = (r.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pairs = lines.map((l) => {
    const i = l.indexOf("\t");
    return i < 0 ? { name: l, culture: "" } : { name: l.slice(0, i), culture: l.slice(i + 1) };
  });
  return {
    voices: pairs.map((p) => p.name).filter(Boolean),
    zh: pairs.filter((p) => p.culture.toLowerCase().startsWith("zh")).map((p) => p.name),
  };
}

const PROBE = probe();

export const SAPI_VOICES = PROBE.voices;
/** The auto-selection path promises a zh voice; without one it cannot keep that promise. */
export const SAPI_ZH_VOICES = PROBE.zh;
export const HAS_SAPI_VOICE = PROBE.voices.length > 0;
export const SAPI_GAP = HAS_SAPI_VOICE
  ? ""
  : process.platform === "win32"
    ? "this Windows host has no enabled SAPI voice, so synthesis cannot be exercised here"
    : "SAPI only exists on Windows";
