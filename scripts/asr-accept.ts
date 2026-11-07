import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadCharacter, ConfigError } from "../src/config.ts";
import { Engine } from "../src/engine.ts";
import { providerFromEnv } from "./../src/provider.ts";
import { speechFromConfig } from "../src/speech.ts";
import { asrFromConfigWithSapi } from "../src/asr-sapi.ts";
import { AsrError, canHear, type AsrProvider } from "../src/asr.ts";
import type { SpeechProvider } from "../src/speech.ts";
import { SapiSpeech } from "../src/speech.ts";

/**
 * Acceptance for the ear.
 *
 * Two different claims get checked, and they deserve different strictness:
 *
 *   1. Mechanical (pass/fail): every sentence comes back as *some* text, the
 *      transcript reaches the engine, and the engine produces a reply. This is
 *      what "ASR is connected" means and it must hold every run.
 *   2. Accuracy (reported, not gated): how close the recognised text is to the
 *      sentence that was actually said. Windows' own recogniser is the 7-era
 *      engine and gets ordinary Mandarin wrong in ways no threshold should bless.
 *      The number is printed for a human to judge, because a script that decides
 *      "0.62 overlap is good enough" is deciding what your character may mishear.
 *
 * Exit: 0 mechanical checks passed, 1 something is actually broken, 3 unverified
 * (no recogniser configured - nothing was measured).
 */

const SENTENCES = [
  "今晚有人来吗？",
  "外面在下雨。",
  "我刚看完一本书，结局不太好。",
  "你说我明天还要不要开门。",
  "我有点困了。",
];

const USAGE = [
  "usage: node scripts/asr-accept.ts --character <dir> [--out <dir>] [--engine sapi|http|cli]",
  "",
  "  --character <dir>  the character whose [asr] block is under test (required)",
  "  --out <dir>        where transcripts and the report are written (default ./out/asr-accept)",
  "  --engine <name>    override [asr] engine for this run, e.g. sapi",
  "  --help             show this message",
].join("\n");

/** Character overlap after dropping punctuation: forgiving of order, not of missing words. */
function overlap(said: string, heard: string): number {
  const norm = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");
  const a = norm(said);
  const b = norm(heard);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  let hits = 0;
  const pool = [...b];
  for (const ch of a) {
    const i = pool.indexOf(ch);
    if (i >= 0) {
      hits++;
      pool.splice(i, 1);
    }
  }
  return hits / Math.max(a.length, b.length);
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      options: {
        character: { type: "string" },
        out: { type: "string" },
        engine: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    }).values;
  } catch (err) {
    console.error((err as Error).message + "\n\n" + USAGE);
    return 2;
  }

  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.character) {
    console.error(USAGE);
    return 2;
  }

  let character;
  try {
    character = await loadCharacter(args.character);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error("config error: " + err.message);
      return 1;
    }
    throw err;
  }

  const outDir = resolve(args.out ?? join("out", "asr-accept"));
  await mkdir(outDir, { recursive: true });

  const asrConfig = args.engine ? { ...character.asr, engine: args.engine } : character.asr;
  let asr: AsrProvider;
  try {
    asr = asrFromConfigWithSapi(asrConfig, process.env);
  } catch (err) {
    if (err instanceof AsrError) {
      console.error("asr error: " + err.message);
      return 1;
    }
    throw err;
  }

  console.log("character: " + character.name + "  (" + character.rootDir + ")");
  console.log("ears:      " + asr.id);
  console.log("out:       " + outDir);
  console.log("");

  if (!canHear(asr)) {
    console.log("No recogniser is configured ([asr] engine = none or silent), so nothing");
    console.log("was measured. Point [asr] at sapi, http, or cli and run again.");
    console.log("");
    console.log("RESULT: UNVERIFIED");
    return 3;
  }

  // The mouth is used to produce the test signal: whatever engine this character
  // speaks with is also what "says" the sentences, so the ear is tested against
  // audio the project itself produces.
  let speech: SpeechProvider;
  try {
    speech = speechFromConfig(character.voice, process.env);
  } catch {
    speech = new SapiSpeech();
  }
  if (speech.id === "silent") {
    // A silent mouth produces no test signal, so borrow the Windows one rather
    // than declaring the ear untestable.
    speech = new SapiSpeech();
  }

  const rows: { said: string; heard: string; score: number; confidence?: number; ms: number }[] = [];
  let failures = 0;

  for (const said of SENTENCES) {
    const clip = await speech.speak(said);
    const t = await asr.transcribe(clip.audio);
    const heard = t.text.trim();
    const score = overlap(said, heard);
    rows.push({ said, heard, score, confidence: t.confidence, ms: Math.round(clip.audio.durationMs) });
    const flag = heard ? " " : "  <- empty";
    console.log(
      "  " + JSON.stringify(said) + " -> " + JSON.stringify(heard) +
        "  overlap " + score.toFixed(2) +
        (t.confidence !== undefined ? " conf " + t.confidence.toFixed(2) : "") + flag,
    );
    if (!heard) failures++;
  }

  const mean = rows.reduce((s, r) => s + r.score, 0) / rows.length;
  console.log("");
  console.log("mean character overlap: " + mean.toFixed(2) + " over " + rows.length + " sentences");
  console.log("(reported, not gated: this engine's accuracy is a property of the engine,");
  console.log(" not of the wiring, and only a human can say what a character may mishear)");

  // Mechanical claim: the transcript reaches the engine and the engine answers.
  const engine = new Engine({
    character,
    provider: providerFromEnv(process.env),
    speech,
    stateDir: join(outDir, "state"),
    voice: false,
  });

  const firstHeard = rows.map((r) => r.heard).find((h) => h.length > 0) ?? "";
  let reply = "";
  if (firstHeard) {
    for await (const event of engine.turn(firstHeard)) {
      if (event.type === "reply") reply = event.text;
    }
  }
  const turnOk = reply.length > 0;
  if (!turnOk) failures++;

  console.log("");
  console.log("turn: heard " + JSON.stringify(firstHeard) + " -> replied " + JSON.stringify(reply.slice(0, 80)));
  console.log("  " + (turnOk ? "the transcript reached the engine and it answered" : "the transcript did NOT produce a reply"));

  await writeFile(
    join(outDir, "asr-accept.json"),
    JSON.stringify(
      {
        asr: asr.id,
        speech: speech.id,
        sentences: rows,
        meanOverlap: mean,
        turn: { heard: firstHeard, reply, ok: turnOk },
        failures,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log("");
  console.log("written: " + join(outDir, "asr-accept.json"));
  console.log("");
  console.log("Necessary, not sufficient: this proves audio went in and a turn came out.");
  console.log("Whether the character heard what you meant is a human judgement - read the");
  console.log("pairs above and listen to a real microphone run before believing it.");
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
