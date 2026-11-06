/**
 * Acceptance: hold one character across ten consecutive turns, with voice.
 *
 * M1 criterion (docs/ARCHITECTURE.md): 能连续对话 10 轮不掉人设.
 * M2 criterion: 能说话，有口型.
 *
 * Half of this is mechanical and can be checked here; the other half — whether
 * the replies still sound like the character, and whether the mouth curve
 * actually tracks the words — needs a human listening to the audio and a real
 * model behind the provider.
 *
 * So this script refuses to declare success on its own. It prints the
 * transcript, runs the mechanical checks, writes the audio to disk when asked,
 * and exits non-zero unless a real endpoint was configured AND every check
 * passed. With no endpoint it says so and exits 3: "the loop ran, the persona
 * is unverified".
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadCharacter } from "../src/config.ts";
import { Engine } from "../src/engine.ts";
import { providerFromEnv } from "../src/provider.ts";
import { speechFromConfig } from "../src/speech.ts";
import { encodeWav } from "../src/audio/wav.ts";
import { envelopeStats, type MouthFrame } from "../src/audio/envelope.ts";

const UTTERANCES = [
  "今晚有人来吗？",
  "外面在下雨。",
  "我刚看完一本书，结局不太好。",
  "你说我明天还要不要开门。",
  "我有点困了。",
  "你在这儿待多久了？",
  "书架最上面那层是谁放的？",
  "如果没人来，你也会一直在吗？",
  "我今天没吃晚饭。",
  "那我现在走了。",
];

/** Phrases that mean the persona has slipped into being a general assistant. */
const DRIFT = [
  "作为AI",
  "作为 AI",
  "作为一个人工智能",
  "语言模型",
  "As an AI",
  "我是一个AI",
  "我是一个 AI",
];

interface Round {
  user: string;
  reply: string;
  ms: number;
  voiceMs: number;
  audio: { durationMs: number; sampleRate: number; samples: number; peak: number } | null;
  mouth: MouthFrame[] | null;
  speechEngine: string | null;
}

const USAGE = [
  "usage: node scripts/accept.ts <character-dir> [--out <dir>] [--text-only]",
  "",
  "  --out <dir>   also write reply-N.wav and mouth-N.json for listening and inspection",
  "  --text-only   skip speech entirely (M1 behaviour)",
].join("\n");

function check(rounds: Round[], voiced: boolean): string[] {
  const problems: string[] = [];
  if (rounds.length !== UTTERANCES.length) {
    problems.push("expected " + UTTERANCES.length + " rounds, got " + rounds.length);
  }
  for (const [i, r] of rounds.entries()) {
    const n = i + 1;
    if (!r.reply.trim()) problems.push("round " + n + ": empty reply");
    for (const phrase of DRIFT) {
      if (r.reply.includes(phrase)) problems.push("round " + n + ": persona drift (" + phrase + ")");
    }
    if (r.reply.length > 240) {
      problems.push("round " + n + ": reply is " + r.reply.length + " chars, too long to speak");
    }
    if (r.reply.includes(r.user)) {
      problems.push("round " + n + ": reply echoes the user verbatim");
    }
    if (voiced) {
      // "It returned exit 0" is not evidence that audio came out of it.
      if (!r.audio) problems.push("round " + n + ": no audio was synthesized");
      else if (r.audio.samples < 100) problems.push("round " + n + ": audio is " + r.audio.samples + " samples, too short to be speech");
      if (!r.mouth) problems.push("round " + n + ": no mouth curve");
      else if (r.mouth.length < 4) problems.push("round " + n + ": mouth curve has only " + r.mouth.length + " frames");
      // A curve that never opens means the renderer would stand there with a
      // closed mouth while the audio plays — the one failure this is meant to
      // catch. The silent engine is honestly all-closed, so it is exempt.
      if (r.mouth && r.speechEngine !== "silent") {
        const peak = Math.max(...r.mouth.map((f) => f.open));
        if (peak < 0.1) problems.push("round " + n + ": mouth never opens (peak " + peak + ")");
      }
    }
  }
  const replies = rounds.map((r) => r.reply);
  for (let i = 0; i < replies.length; i++) {
    for (let j = i + 1; j < replies.length; j++) {
      if (replies[i] === replies[j]) {
        problems.push("rounds " + (i + 1) + " and " + (j + 1) + ": identical replies");
      }
    }
  }
  return problems;
}

function peakOf(frames: MouthFrame[]): number {
  return frames.length === 0 ? 0 : Math.max(...frames.map((f) => f.open));
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dir = argv.find((a) => !a.startsWith("--"));
  const outIndex = argv.indexOf("--out");
  const outDir = outIndex >= 0 && argv[outIndex + 1] ? resolve(argv[outIndex + 1]) : null;
  const textOnly = argv.includes("--text-only");

  if (!dir || argv.includes("--help")) {
    console.error(USAGE);
    return 2;
  }

  const character = await loadCharacter(dir);
  const provider = providerFromEnv(process.env);
  const speech = speechFromConfig(character.voice, process.env);
  const stateDir = await mkdtemp(join(tmpdir(), "attune-accept-"));
  const engine = new Engine({ character, provider, speech, stateDir, voice: !textOnly });

  console.log("character: " + character.name);
  console.log("provider:  " + provider.id);
  console.log("voice:     " + (textOnly ? "off (--text-only)" : speech.id));
  console.log("state:     " + stateDir + " (temporary, removed on exit)");
  if (outDir) console.log("artifacts: " + outDir + "\n");
  else console.log("");

  if (outDir) await mkdir(outDir, { recursive: true });

  const rounds: Round[] = [];
  try {
    for (const utterance of UTTERANCES) {
      const started = Date.now();
      let reply = "";
      let clip: { engine: string; durationMs: number; audio: { durationMs: number; sampleRate: number; samples: Float32Array } } | null = null;
      let frames: MouthFrame[] | null = null;
      for await (const event of engine.turn(utterance)) {
        if (event.type === "reply") reply = event.text;
        if (event.type === "speech") clip = event;
        if (event.type === "mouth") frames = event.frames;
      }
      const ms = Date.now() - started;
      const voiceMs = clip ? ms : 0;

      const n = rounds.length + 1;
      let audio: Round["audio"] = null;
      if (clip) {
        let peak = 0;
        for (let i = 0; i < clip.audio.samples.length; i++) {
          const v = Math.abs(clip.audio.samples[i]);
          if (v > peak) peak = v;
        }
        audio = {
          durationMs: Math.round(clip.audio.durationMs),
          sampleRate: clip.audio.sampleRate,
          samples: clip.audio.samples.length,
          peak: Math.round(peak * 1000) / 1000,
        };
        if (outDir) {
          await writeFile(join(outDir, "reply-" + n + ".wav"), encodeWav(clip.audio.samples, clip.audio.sampleRate));
        }
      }
      if (outDir && frames) {
        await writeFile(join(outDir, "mouth-" + n + ".json"), JSON.stringify({ fps: 60, frames }, null, 1) + "\n", "utf8");
      }

      rounds.push({ user: utterance, reply, ms, voiceMs, audio, mouth: frames, speechEngine: clip?.engine ?? null });

      console.log("you:   " + utterance);
      console.log("them:  " + reply + "   (" + ms + "ms)");
      if (clip && frames) {
        const st = envelopeStats(frames, clip.audio.durationMs);
        console.log(
          "audio: " + audio!.durationMs + "ms @" + audio!.sampleRate + "Hz peak " + audio!.peak +
            " | mouth: " + st.frames + " frames, " + st.voicedFrames + " voiced, peak " + st.peakOpen,
        );
      }
      console.log("");
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }

  if (outDir) {
    await writeFile(
      join(outDir, "accept.json"),
      JSON.stringify(
        {
          character: character.name,
          provider: provider.id,
          voice: textOnly ? null : speech.id,
          rounds: rounds.map((r) => ({
            user: r.user,
            reply: r.reply,
            ms: r.ms,
            audio: r.audio,
            mouth: r.mouth ? envelopeStats(r.mouth, r.audio?.durationMs ?? 0) : null,
          })),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }

  const voiced = !textOnly;
  const offline = provider.id === "offline";

  if (offline) {
    console.log("---- mechanical checks ----");
    console.log("skipped: the offline provider echoes the prompt, so drift checks prove nothing here.");
    if (voiced) {
      // Voice can still be judged without a model: the audio path does not
      // depend on who wrote the words.
      const voiceProblems = check(rounds, true).filter((p) => !p.includes("drift") && !p.includes("echoes"));
      if (voiceProblems.length === 0) {
        // Do not claim the mouth opens when the engine is the silent one: it
        // is honestly all-closed, and saying otherwise would be a lie that
        // survives into someone's notes.
        if (speech.id === "silent") {
          console.log("voice path: 10 turns synthesized by the silent engine; curves are all-closed by design.");
          console.log("             set voice engine = \"sapi\" (Windows) or \"http\" to hear anything.");
        } else {
          console.log("voice path: 10 turns synthesized with " + speech.id + ", each with a mouth curve that opens.");
        }
      } else {
        for (const p of voiceProblems) console.log("fail: " + p);
      }
    }
    console.log("\n---- human judgement ----");
    console.log("UNVERIFIED: no model endpoint was configured, so the replies are offline filler.");
    console.log("Set ATTUNE_BASE_URL and ATTUNE_MODEL, then run this again.");
    return 3;
  }

  const problems = check(rounds, voiced);

  console.log("---- mechanical checks ----");
  if (problems.length === 0) {
    console.log(
      "pass: " + rounds.length + " rounds, no drift phrases, no repeats, no echo, all replies speakable" +
        (voiced ? ", all voiced with an opening mouth curve" : ""),
    );
  } else {
    for (const p of problems) console.log("fail: " + p);
  }

  console.log("\n---- human judgement ----");
  console.log("Read the transcript above and answer: is this still " + character.name + " by round 10?");
  if (voiced) console.log("Listen to the wav files and answer: does the mouth curve match the words?");

  return problems.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
