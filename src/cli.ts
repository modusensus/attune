import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCharacter, ConfigError } from "./config.ts";
import { Engine } from "./engine.ts";
import { providerFromEnv } from "./provider.ts";
import { SpeechError, speechFromConfig } from "./speech.ts";
import { AsrError, canHear, type AsrProvider } from "./asr.ts";
import { asrFromConfigWithSapi } from "./asr-sapi.ts";
import { CaptureError, FfmpegCapture, WavFileCapture, type Capture } from "./audio/capture.ts";
import { RendererError } from "./render/backend.ts";
import { describeLoadedRenderer, rendererFromConfig } from "./render/load.ts";
import { Stage } from "./render/stage.ts";

const USAGE = [
  "attune - realtime voice conversation engine (M5: ears, mouth, listening, 2D/3D rigs)",
  "",
  "usage: node src/cli.ts --character <dir> [--state <dir>] [--text-only] [--say-file <wav>]",
  "",
  "  --character <dir>  directory holding character.toml (required)",
  "  --state <dir>      where transcripts are stored (default: ~/.attune)",
  "  --text-only        skip speech synthesis (M1 behaviour)",
  "  --say-file <wav>   speak one turn from an existing wav, then exit",
  "  --help             show this message",
  "",
  "in the session:",
  "  /talk              start recording; press enter again to stop and send",
  "  /devices           list the microphones ffmpeg can see",
  "  /quit, /exit       leave",
  "",
  "environment:",
  "  ATTUNE_BASE_URL     OpenAI-compatible chat endpoint, e.g. http://127.0.0.1:1234/v1",
  "  ATTUNE_MODEL        model id served by that endpoint",
  "  ATTUNE_API_KEY      optional bearer token",
  "  ATTUNE_TTS_BASE_URL OpenAI-compatible speech endpoint (voice.engine = \"http\")",
  "  ATTUNE_TTS_MODEL    model id for that speech endpoint",
  "  ATTUNE_TTS_API_KEY  optional bearer token for speech",
  "  ATTUNE_ASR_BASE_URL OpenAI-compatible transcription endpoint (asr.engine = \"http\")",
  "  ATTUNE_ASR_MODEL    model id for that transcription endpoint",
  "  ATTUNE_ASR_API_KEY  optional bearer token for transcription",
  "  ATTUNE_ASR_LANGUAGE BCP-47 hint, e.g. zh",
  "  ATTUNE_ASR_COMMAND  command line for asr.engine = \"cli\"; must contain {audio}",
  "",
  "With no chat endpoint the engine runs offline: the loop works, the replies are",
  "obvious filler, nothing is downloaded. With no speech engine the audio is silent",
  "but still correctly timed, so the mouth curve is real. With no recogniser the",
  "microphone is never opened - recording into an engine that cannot hear is theatre.",
].join("\n");

interface Args {
  character?: string;
  state?: string;
  "text-only"?: boolean;
  "say-file"?: string;
  help?: boolean;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs({
      options: {
        character: { type: "string" },
        state: { type: "string" },
        "text-only": { type: "boolean" },
        "say-file": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    }).values as Args;
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

  let asr;
  try {
    asr = asrFromConfigWithSapi(character.asr, process.env);
  } catch (err) {
    if (err instanceof AsrError) {
      console.error("asr error: " + err.message);
      return 1;
    }
    throw err;
  }

  let renderer;
  try {
    renderer = await rendererFromConfig(character);
  } catch (err) {
    if (err instanceof RendererError) {
      console.error("renderer error: " + err.message);
      return 1;
    }
    throw err;
  }

  const voiceEnabled = !args["text-only"] && speech.id !== "silent";
  // The stage owns the clock. It is created even for "none" so that the mouth
  // curve is still sampled and can be printed — a backend with no rig is not a
  // reason to lose sight of what the character is doing.
  const stage = new Stage(renderer.backend);
  const engine = new Engine({ character, provider, speech, stateDir, voice: voiceEnabled, stage });

  const ears = canHear(asr);

  console.log("attune · " + character.name);
  console.log("provider: " + provider.id);
  console.log("voice:    " + speech.id + (voiceEnabled ? "" : " (not synthesized)"));
  console.log("ears:     " + asr.id + (ears ? "" : " (not listening)"));
  const rigNote = describeLoadedRenderer(renderer);
  console.log("renderer: " + renderer.backend.id + (rigNote ? "  (" + rigNote + ")" : ""));
  console.log("state:    " + stateDir);

  /** One turn, printed as it streams. Shared by typed text and recognised audio. */
  const runTurn = async (text: string): Promise<void> => {
    let printed = false;
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
      } else if (event.type === "gesture") {
        const moved = event.gestures.map((g) => g.channel).join(", ");
        process.stdout.write("\n  [reaction: " + moved + "]");
      } else if (event.type === "reply") {
        process.stdout.write("\n");
      }
    }
  };

  // Headless path: one wav in, one reply out. This is the way to exercise the
  // whole ear-to-mouth loop on a machine with no microphone, and the way a script
  // drives it.
  if (args["say-file"]) {
    const capture = new WavFileCapture(args["say-file"]);
    let audio;
    try {
      await capture.start();
      audio = await capture.stop();
    } catch (err) {
      if (err instanceof CaptureError) {
        console.error("capture error: " + err.message);
        return 1;
      }
      throw err;
    }
    let transcript;
    try {
      transcript = await asr.transcribe(audio);
    } catch (err) {
      if (err instanceof AsrError) {
        console.error("asr error: " + err.message);
        return 1;
      }
      throw err;
    }
    const heard = transcript.text.trim();
    console.log(
      "heard:    " + (heard ? JSON.stringify(heard) : "(nothing)") + "  [" + asr.id + " · " +
        Math.round(audio.durationMs) + "ms audio" + (transcript.confidence !== undefined ? " · conf " + transcript.confidence.toFixed(2) : "") + "]",
    );
    if (!heard) {
      console.error("nothing was recognised, so there is no turn to take");
      return 1;
    }
    try {
      await runTurn(heard);
    } catch (err) {
      console.error("error: " + (err as Error).message);
      return 1;
    }
    return 0;
  }

  console.log("type /quit to exit." + (ears ? " /talk to speak." : "") + "\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const prompt = () => process.stdout.write(ears ? "you (or /talk): " : "you: ");
  prompt();

  /** Recording is a two-step gesture because there is no keypress hook here. */
  let recording: Capture | null = null;

  for await (const line of rl) {
    const text = line.trim();

    if (recording) {
      // An empty line is how you end a recording; anything else is treated the
      // same way. Waiting for a specific word would invite typos to leave the
      // microphone open.
      const capture = recording;
      recording = null;
      let audio;
      try {
        audio = await capture.stop();
      } catch (err) {
        console.error("capture error: " + (err as Error).message);
        prompt();
        continue;
      }
      let heard = "";
      try {
        const transcript = await asr.transcribe(audio);
        heard = transcript.text.trim();
        console.log(
          "  [" + asr.id + " heard " + (heard ? JSON.stringify(heard) : "nothing") +
            " · " + Math.round(audio.durationMs) + "ms" +
            (transcript.confidence !== undefined ? " · conf " + transcript.confidence.toFixed(2) : "") + "]",
        );
      } catch (err) {
        console.error("asr error: " + (err as Error).message);
        prompt();
        continue;
      }
      if (!heard) {
        console.log("  (nothing recognised; try again)");
        prompt();
        continue;
      }
      try {
        await runTurn(heard);
      } catch (err) {
        console.error("error: " + (err as Error).message);
      }
      prompt();
      continue;
    }

    if (!text) continue;
    if (text === "/quit" || text === "/exit") break;

    if (text === "/devices") {
      try {
        const capture = new FfmpegCapture();
        const devices = await capture.listDevices();
        console.log("  input backend: " + capture.backend);
        for (const d of devices) {
          console.log("  " + d.name + (d.alternative ? "  (" + d.alternative + ")" : ""));
        }
        if (capture.backend === "avfoundation") {
          console.log('  on macOS the left column is the index ffmpeg wants: device = "0"');
        }
      } catch (err) {
        console.error("  " + (err as Error).message);
      }
      prompt();
      continue;
    }

    if (text === "/talk") {
      if (!ears) {
        console.log("  no recogniser is configured ([asr] engine = none)");
        prompt();
        continue;
      }
      const capture = new FfmpegCapture({ sampleRate: 16000 });
      try {
        await capture.start();
      } catch (err) {
        console.error("capture error: " + (err as Error).message);
        prompt();
        continue;
      }
      recording = capture;
      console.log("  recording… press enter to stop.");
      continue;
    }

    try {
      await runTurn(text);
    } catch (err) {
      console.error("error: " + (err as Error).message);
    }
    prompt();
  }

  if (recording) await recording.abort().catch(() => {});
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
