import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCharacter, ConfigError } from "./config.ts";
import { Engine } from "./engine.ts";
import { providerFromEnv } from "./provider.ts";

const USAGE = [
  "attune - realtime voice conversation engine (M1: text loop)",
  "",
  "usage: node src/cli.ts --character <dir> [--state <dir>]",
  "",
  "  --character <dir>  directory holding character.toml (required)",
  "  --state <dir>      where transcripts are stored (default: ~/.attune)",
  "  --help             show this message",
  "",
  "environment:",
  "  ATTUNE_BASE_URL    OpenAI-compatible endpoint, e.g. http://127.0.0.1:1234/v1",
  "  ATTUNE_MODEL       model id served by that endpoint",
  "  ATTUNE_API_KEY     optional bearer token",
  "",
  "With no endpoint configured the engine runs in offline mode: the loop works,",
  "the replies are obvious filler, and nothing is downloaded.",
].join("\n");

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      options: {
        character: { type: "string" },
        state: { type: "string" },
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
  const engine = new Engine({ character, provider, stateDir });

  console.log("attune · " + character.name);
  console.log("provider: " + provider.id);
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
