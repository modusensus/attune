/**
 * M1 acceptance: hold one character across ten consecutive turns.
 *
 * The criterion in docs/ARCHITECTURE.md is "能连续对话 10 轮不掉人设". Half of
 * that is mechanical and can be checked here; the other half — whether the
 * replies still sound like the character — needs a human reading the
 * transcript, and a real model behind the provider.
 *
 * So this script refuses to declare success on its own. It prints the
 * transcript, runs the mechanical checks, and exits non-zero unless a real
 * endpoint was configured AND every check passed. With no endpoint it says so
 * and exits 3: "the loop ran, the persona is unverified".
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCharacter } from "../src/config.ts";
import { Engine } from "../src/engine.ts";
import { providerFromEnv } from "../src/provider.ts";

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
}

function check(rounds: Round[]): string[] {
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

async function main(): Promise<number> {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node scripts/accept.ts <character-dir>");
    return 2;
  }

  const character = await loadCharacter(dir);
  const provider = providerFromEnv(process.env);
  const stateDir = await mkdtemp(join(tmpdir(), "attune-accept-"));
  const engine = new Engine({ character, provider, stateDir });

  console.log("character: " + character.name);
  console.log("provider:  " + provider.id);
  console.log("state:     " + stateDir + " (temporary, removed on exit)\n");

  const rounds: Round[] = [];
  try {
    for (const utterance of UTTERANCES) {
      const started = Date.now();
      let reply = "";
      for await (const event of engine.turn(utterance)) {
        if (event.type === "reply") reply = event.text;
      }
      const ms = Date.now() - started;
      rounds.push({ user: utterance, reply, ms });
      console.log("you:   " + utterance);
      console.log("them:  " + reply + "   (" + ms + "ms)\n");
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }

  const offline = provider.id === "offline";

  if (offline) {
    console.log("---- mechanical checks ----");
    console.log("skipped: the offline provider echoes the prompt, so drift checks prove nothing here.");
    console.log("\n---- human judgement ----");
    console.log("UNVERIFIED: no model endpoint was configured, so the replies are offline filler.");
    console.log("Set ATTUNE_BASE_URL and ATTUNE_MODEL, then run this again.");
    return 3;
  }

  const problems = check(rounds);

  console.log("---- mechanical checks ----");
  if (problems.length === 0) {
    console.log("pass: " + rounds.length + " rounds, no drift phrases, no repeats, no echo, all replies speakable");
  } else {
    for (const p of problems) console.log("fail: " + p);
  }

  console.log("\n---- human judgement ----");
  console.log("Read the transcript above and answer: is this still " + character.name + " by round 10?");

  return problems.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
