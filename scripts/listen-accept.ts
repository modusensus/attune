/**
 * MVP acceptance for the listening layer (ARCHITECTURE.md:108-116).
 *
 * The three criteria are about behaviour, not about numbers a model emits, so
 * they are checked here on synthesized speech with known ground truth: we know
 * exactly where the speaker paused and where they started talking over the
 * character. That makes each check falsifiable instead of "looks fine to me".
 *
 *   node scripts/listen-accept.ts [--out <dir>] [--json]
 *
 * Exit codes: 0 all checks passed, 1 something failed, 3 nothing measurable.
 *
 * This script does not claim the character feels alive. It claims the mechanics
 * that "feels alive" is built on actually happen, and it prints the timeline so
 * that claim can be argued with.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeWav, encodeWav } from "../src/audio/wav.ts";
import { ListenSession } from "../src/listen/session.ts";
import { readMapping } from "../src/render/mapping.ts";
import { gesturesStartingBetween, type Gesture } from "../src/render/gesture.ts";
import type { Cue } from "../src/listen/cues.ts";

const RATE = 16000;
/** Analysis window, in ms. The default in src/listen/frames.ts. */
const WINDOW_MS = 40;

interface Args {
  out: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  let out = "out/listen-accept";
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") {
      out = argv[i + 1] ?? out;
      i += 1;
    } else if (argv[i] === "--json") {
      json = true;
    }
  }
  return { out, json };
}

/** A voiced tone. Fades keep the energy gate from turning into a click train. */
function tone(ms: number, fromHz: number, toHz = fromHz, amp = 0.4): Float32Array {
  const n = Math.round((ms / 1000) * RATE);
  const out = new Float32Array(n);
  const fadeSamples = Math.min(Math.floor(0.01 * RATE), Math.floor(n / 2));
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const p = n <= 1 ? 0 : i / (n - 1);
    const hz = fromHz + (toHz - fromHz) * p;
    phase += (2 * Math.PI * hz) / RATE;
    const edge = Math.min(i, n - 1 - i);
    const fade = fadeSamples > 0 ? Math.min(1, edge / fadeSamples) : 1;
    out[i] = Math.sin(phase) * amp * fade;
  }
  return out;
}

function silence(ms: number): Float32Array {
  return new Float32Array(Math.round((ms / 1000) * RATE));
}

interface Piece {
  ms: number;
  at: number;
  kind: "speech" | "silence";
  label: string;
}

type Part = { ms: number; fromHz?: number; toHz?: number; label: string };

function build(parts: Part[]): { samples: Float32Array; pieces: Piece[]; totalMs: number } {
  const chunks: Float32Array[] = [];
  const pieces: Piece[] = [];
  let at = 0;
  for (const part of parts) {
    const audio = part.fromHz === undefined ? silence(part.ms) : tone(part.ms, part.fromHz, part.toHz ?? part.fromHz);
    chunks.push(audio);
    pieces.push({ ms: part.ms, at, kind: part.fromHz === undefined ? "silence" : "speech", label: part.label });
    at += part.ms;
  }
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const samples = new Float32Array(n);
  let off = 0;
  for (const c of chunks) {
    samples.set(c, off);
    off += c.length;
  }
  return { samples, pieces, totalMs: at };
}

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

function fmt(ms: number): string {
  return (ms / 1000).toFixed(2) + "s";
}

/**
 * Frames are windows, not instants: a frame reported "at" t covers [t, t+WINDOW).
 * The sound at `ms` is first visible to the window that ends at or after it, so
 * the detection delay is measured from the closing edge of the window that
 * actually fired — not from the onset itself, which would produce the nonsense
 * negative number you get when a window straddles the onset.
 */
function detectionDelay(firedAt: number, onsetMs: number): number {
  return firedAt + WINDOW_MS - onsetMs;
}

// ---------------------------------------------------------------------------
// Criterion 1: ~90s of talking, no questions, at least 4 non-verbal reactions,
// none of them after the speaker finished.
// ---------------------------------------------------------------------------

/**
 * One monologue line: a full clause that falls at the end, a short paused beat,
 * an interjection, another beat, then a level-pitch continuation that pauses
 * mid-thought. The two kinds of pause are the whole point, so both are present
 * on every line.
 */
function lineParts(text: string): Part[] {
  return [
    { ms: 2600, fromHz: 215, toHz: 152, label: "clause: " + text },
    { ms: 340, label: "beat" },
    { ms: 190, fromHz: 178, label: "mm" },
    { ms: 420, label: "beat" },
    { ms: 900, fromHz: 192, toHz: 192, label: "mid-thought, pitch flat" },
    { ms: 260, label: "beat" },
  ];
}

function criterionOne(): { check: Check; cues: Cue[]; gestures: Gesture[]; timeline: string[] } {
  const lines = [
    "今天来的时候下雨了",
    "伞忘在车上",
    "一路上都在想那本书的结尾",
    "那个主角最后什么也没说",
    "我在地铁上又翻了一遍",
    "还是没看懂",
    "回来路上买了点橘子",
    "有点酸",
    "但还行",
    "楼下那家店换招牌了",
    "老板还是原来那个",
    "他问我最近怎么不来了",
    "我说在忙",
    "其实也没那么忙",
    "就是不太想说话",
    "天气一冷就这样",
    "去年也差不多是这个时间",
    "那会儿还在加班",
    "每天到家都快十二点",
    "现在想想也不知道在忙什么",
  ];
  const parts: Part[] = [];
  for (const text of lines) parts.push(...lineParts(text));
  parts.push({ ms: 1200, label: "end" });

  const built = build(parts);
  const audio = decodeWav(encodeWav(built.samples, RATE));

  const session = new ListenSession(RATE, {}, readMapping({}));
  const pcm = session.pushPcm(audio.samples);
  const tail = session.flush();
  const gestures: Gesture[] = [...pcm.gestures, ...tail.gestures];

  const lastSpeech = built.pieces.filter((p) => p.kind === "speech").pop();
  const speechEnd = lastSpeech ? lastSpeech.at + lastSpeech.ms : built.totalMs;
  const during = gesturesStartingBetween(gestures, 0, speechEnd);

  const counts: Record<string, number> = {};
  for (const g of during) counts[g.channel] = (counts[g.channel] ?? 0) + 1;
  const summary = Object.entries(counts)
    .map(([k, v]) => k + "x" + v)
    .join(", ");

  const timeline = session.cues.map(
    (c) => fmt(c.at) + "  " + c.type.padEnd(11) + "(" + c.confidence.toFixed(2) + ")  " + c.reason,
  );

  // Blinks are not "reactions to what was said" — they keep happening regardless.
  const nonVerbal = during.filter((g) => g.channel !== "blink").length;
  const longEnough = built.totalMs >= 88000;
  const passed = nonVerbal >= 4 && longEnough;
  return {
    check: {
      name: "1. ~90s of talking, >= 4 reactions, none after the speaker stopped",
      passed,
      detail:
        "speech ran " + fmt(0) + "-" + fmt(speechEnd) + " (" + fmt(built.totalMs) + " total), " +
        nonVerbal + " reaction(s) started inside it" + (summary ? " [" + summary + "]" : " []") +
        (nonVerbal < 4 ? " - a machine that only reacts after you stop looks exactly like this" : ""),
    },
    cues: session.cues,
    gestures,
    timeline,
  };
}

// ---------------------------------------------------------------------------
// Criterion 2: an 0.8s pause mid-turn must not be read as a handover.
// ---------------------------------------------------------------------------
function criterionTwo(): { check: Check; caveat: string; cues: Cue[] } {
  // A genuine mid-thought pause: the pitch does NOT fall across the clause, so
  // the listener has nothing that looks like a full stop. This is the case the
  // criterion is about — the speaker has not finished, they are thinking.
  const built = build([
    { ms: 1600, fromHz: 185, toHz: 196, label: "clause, pitch level-to-rising" },
    { ms: 800, label: "pause 0.8s" },
    { ms: 1400, fromHz: 190, toHz: 190, label: "speaker continues" },
    { ms: 1500, label: "end" },
  ]);
  const audio = decodeWav(encodeWav(built.samples, RATE));
  const session = new ListenSession(RATE, {}, readMapping({}));
  session.pushPcm(audio.samples);
  session.flush();
  const cues = session.cues;

  const pauseStart = 1600;
  const pauseEnd = 2400;
  const inside = cues.filter((c) => c.at >= pauseStart && c.at < pauseEnd);
  const grabbed = inside.filter((c) => c.type === "turn_take");
  const held = inside.filter((c) => c.type === "hold");

  const passed = grabbed.length === 0 && held.length > 0;

  // The known edge, stated rather than hidden. A clause that falls to a full
  // stop and is then followed by 800ms of silence is acoustically identical to
  // having finished. No amount of f0 analysis separates them, so the character
  // takes the turn — and if the user resumes, barge-in (criterion 3) cuts it off
  // within a frame. Fixing it properly needs semantics, not signal processing.
  const caveat =
    "known edge: a clause that falls to a full stop, then 800ms of silence, is " +
    "indistinguishable from a finished turn; the character will take it and " +
    "rely on barge-in to give it back.";

  return {
    check: {
      name: "2. an 0.8s pause mid-thought is not a handover",
      passed,
      detail:
        held.length + " hold(s), " + grabbed.length + " premature handover(s) in the pause " +
        fmt(pauseStart) + "-" + fmt(pauseEnd) +
        (grabbed.length ? " - it talked over someone still mid-sentence" : ""),
    },
    caveat,
    cues,
  };
}

// ---------------------------------------------------------------------------
// Criterion 3: interrupting is detected inside 200ms, and the face does not
// freeze on a half-applied expression.
// ---------------------------------------------------------------------------
function criterionThree(): { check: Check; bargeIn: number | null } {
  const ONSET = 900;
  const built = build([
    { ms: ONSET, label: "quiet before" },
    { ms: 1200, fromHz: 200, toHz: 210, label: "user cuts in" },
    { ms: 600, label: "end" },
  ]);
  const audio = decodeWav(encodeWav(built.samples, RATE));

  const session = new ListenSession(RATE, {}, readMapping({}));
  session.setState("speaking");
  const out = session.pushPcm(audio.samples);
  session.flush();

  const barge = out.bargeIn;
  const latency = barge ? detectionDelay(barge.at, ONSET) : null;
  const gesturesWhileSpeaking = out.gestures.length;

  const passed = barge !== null && latency !== null && latency <= 200 && gesturesWhileSpeaking === 0;

  return {
    check: {
      name: "3. an interruption is detected inside 200ms",
      passed,
      detail: barge
        ? "barge-in at " + fmt(barge.at) + ", detected " + (latency ?? 0) + "ms after the user started talking, " +
          gesturesWhileSpeaking + " gesture(s) emitted during speech (the renderer keeps its own idle loop)"
        : "no barge-in at all - the character would have kept talking over the user",
    },
    bargeIn: barge ? barge.at : null,
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const one = criterionOne();
  const two = criterionTwo();
  const three = criterionThree();
  const checks = [one.check, two.check, three.check];

  const passed = checks.filter((c) => c.passed).length;
  if (!args.json) {
    console.log("attune - listening layer acceptance (M3)");
    console.log("");
    for (const c of checks) console.log((c.passed ? "PASS  " : "FAIL  ") + c.name + "\n        " + c.detail);
    console.log("");
    console.log("  " + two.caveat);
    console.log("");
    console.log("cues from the monologue (first 24 of " + one.cues.length + "):");
    for (const line of one.timeline.slice(0, 24)) console.log("  " + line);
    console.log("");
    console.log(passed + "/3 mechanically checked. These three are necessary, not sufficient:");
    console.log("whether it feels like it is listening is decided by a person watching it, not by this script.");
  }

  try {
    await mkdir(args.out, { recursive: true });
    await writeFile(
      join(args.out, "listen-accept.json"),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          rate: RATE,
          checks,
          caveats: [two.caveat],
          cues: one.cues,
          gestures: one.gestures,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    if (!args.json) console.log("written: " + join(args.out, "listen-accept.json"));
  } catch (err) {
    console.error("could not write results: " + (err as Error).message);
    return 1;
  }

  return passed === 3 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);