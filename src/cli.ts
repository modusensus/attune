import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCharacter, ConfigError } from "./config.ts";
import { Engine } from "./engine.ts";
import { providerFromEnv } from "./provider.ts";
import { SpeechError, speechFromConfig } from "./speech.ts";

const USAGE = [
  "attune - realtime voice conversation engine (M2: voice loop)",
  "",
  "usage: node src/cli.ts --character <dir> [--state <dir>] [--text-only]",
  "",
  "  --character <dir>  directory holding character.toml (required)",
  "  --state <dir>      where transcripts are stored (default: ~/.attune)",
  "  --text-only        skip speech synthesis (M1 behaviour)",
  "  --help             show this message",
  "",
  "environment:",
  "  ATTUNE_BASE_URL     OpenAI-compatible chat endpoint, e.g. http://127.0.0.1:1234/v1",
  "  ATTUNE_MODEL        model id served by that endpoint",
  "  ATTUNE_API_KEY      optional bearer token",
  "  ATTUNE_TTS_BASE_URL OpenAI-compatible speech endpoint (voice.engine = \"http\")",
  "  ATTUNE_TTS_MODEL    model id for that speech endpoint",
  "  ATTUNE_TTS_API_KEY  optional bearer token for speech",
  "",
  "With no chat endpoint the engine runs offline: the loop works, the replies are",
  "obvious filler, nothing is downloaded. With no speech engine the audio is silent",
  "but still correctly timed, so the mouth curve is real.",
].join("\n");

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      options: {
        character: { type: "string" },
        state: { type: "string" },
        "text-only": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    }).values;
  } catch (err) {
    console.error((err as Error).message + "\n\n" + USAGE);
    return 2;
  }

  if (args.help || !args.character) {
    console.error(USAGE);
    return args.help ? 0 : 2;
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

  const stateDir = args.state ?? join(homedir(), ".attune");
  const provider = providerFromEnv(process.env);

  let speech;
  try {
    speech = speechFromConfig(character.voice, process.env);
  } catch (err) {
    if (err instanceof SpeechError) {
      console.error("speech error: " + err.message);
      return 1;
    }
    throw err;
  }

  const voiceEnabled = !args["text-only"] && speech.id !== "silent";
  const engine = new Engine({ character, provider, speech, stateDir, voice: voiceEnabled });

  console.log("attune · " + character.name);
  console.log("provider: " + provider.id);
  console.log("voice:    " + speech.id + (voiceEnabled ? "" : " (not synthesized)"));
  console.log("state:    " + stateDir);
  console.log("type /quit to exit.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const prompt = () => process.stdout.write("you: ");
  prompt();

  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    if (text === "/quit" || text === "/exit") break;

    let printed = false;
    try {
      for await (const event of engine.turn(text)) {
        if (event.type === "delta") {
          if (!printed) {
            process.stdout.write(character.name + ": ");
            printed = true;
          }
          process.stdout.write(event.text);
        } else if (event.type === "speech") {
          process.stdout.write(
            "\n  [" + event.engine + " · " + Math.round(event.durationMs) + "ms · " +
              event.audio.samples.length + " samples @ " + event.audio.sampleRate + "Hz]",
          );
        } else if (event.type === "mouth") {
          const voiced = event.frames.filter((f) => f.open > 0.1).length;
          process.stdout.write("\n  [mouth: " + event.frames.length + " frames, " + voiced + " voiced]");
        } else if (event.type === "silent-turn") {
          process.stdout.write("\n  [nothing to say aloud: " + event.reason + "]");
        } else if (event.type === "reply") {
          process.stdout.write("\n");
        }
      }
    } catch (err) {
      if (printed) process.stdout.write("\n");
      console.error("error: " + (err as Error).message);
    }
    prompt();
  }

  rl.close();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
