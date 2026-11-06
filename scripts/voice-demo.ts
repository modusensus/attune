import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadCharacter } from "../src/config.ts";
import { Engine } from "../src/engine.ts";
import { providerFromEnv } from "../src/provider.ts";
import { speechFromConfig } from "../src/speech.ts";
import { encodeWav } from "../src/audio/wav.ts";
import { envelopeStats } from "../src/audio/envelope.ts";

/**
 * One voiced turn, written to disk so the result can be listened to and looked
 * at instead of taken on trust. "It returned exit 0" is not evidence that a
 * wav file came out of it; this script leaves both the audio and the curve
 * behind for inspection.
 */

const USAGE = [
  "attune voice demo - synthesize one turn and write the artifacts to disk",
  "",
  "usage: node scripts/voice-demo.ts --character <dir> [--out <dir>] [--say <text>]",
  "",
  "  --character <dir>  directory holding character.toml (required)",
  "  --out <dir>        where to write (default: ./out/voice-demo)",
  "  --say <text>       the utterance; default is a sentence that invites a pause",
].join("\n");

function parse(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "";
    }
  }
  return out;
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  if (args.help !== undefined) {
    console.log(USAGE);
    return 0;
  }
  if (!args.character) {
    console.error(USAGE);
    return 2;
  }

  const character = await loadCharacter(args.character);
  const provider = providerFromEnv(process.env);
  const speech = speechFromConfig(character.voice, process.env);
  const outDir = resolve(args.out ?? join(process.cwd(), "out", "voice-demo"));
  const stateDir = join(homedir(), ".attune", "voice-demo");
  const utterance = args.say ?? "今晚有人来吗？";

  const engine = new Engine({ character, provider, speech, stateDir });

  let reply = "";
  let clip = null;
  let frames = null;
  for await (const event of engine.turn(utterance)) {
    if (event.type === "reply") reply = event.text;
    if (event.type === "speech") clip = event;
    if (event.type === "mouth") frames = event.frames;
  }
  if (!clip || !frames) {
    console.error("no speech was produced; is voice disabled for this character?");
    return 1;
  }

  await mkdir(outDir, { recursive: true });
  const wavPath = join(outDir, "reply.wav");
  const mouthPath = join(outDir, "mouth.json");
  const metaPath = join(outDir, "turn.json");

  await writeFile(wavPath, encodeWav(clip.audio.samples, clip.audio.sampleRate));
  await writeFile(mouthPath, JSON.stringify({ fps: 60, frames }, null, 1) + "\n", "utf8");
  await writeFile(
    metaPath,
    JSON.stringify(
      {
        character: character.name,
        provider: provider.id,
        speech: clip.engine,
        utterance,
        reply,
        audio: {
          path: wavPath,
          sampleRate: clip.audio.sampleRate,
          channels: clip.audio.channels,
          bitsPerSample: clip.audio.bitsPerSample,
          durationMs: Math.round(clip.audio.durationMs),
          samples: clip.audio.samples.length,
        },
        mouth: envelopeStats(frames, clip.audio.durationMs),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const stats = envelopeStats(frames, clip.audio.durationMs);
  console.log("character: " + character.name);
  console.log("provider:  " + provider.id);
  console.log("speech:    " + clip.engine);
  console.log("utterance: " + utterance);
  console.log("reply:     " + reply);
  console.log(
    "audio:     " + Math.round(clip.audio.durationMs) + "ms, " + clip.audio.sampleRate + "Hz, " +
      clip.audio.channels + "ch, " + clip.audio.bitsPerSample + "bit -> " + wavPath,
  );
  console.log(
    "mouth:     " + stats.frames + " frames, " + stats.voicedFrames + " voiced, peak " +
      stats.peakOpen + " -> " + mouthPath,
  );
  console.log("turn:      " + metaPath);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
