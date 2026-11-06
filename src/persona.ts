import { readFile } from "node:fs/promises";
import type { CharacterConfig, Message, Turn } from "./types.ts";

/**
 * The system prompt is assembled, never hand-written in engine code: persona
 * card + memory + the rules that keep a text loop from drifting into an
 * assistant. Any rule that mentions a specific character would break the
 * "character is a config" constraint, so there are none.
 */
const FRAME = [
  "You are playing a character in a live conversation, not acting as a general assistant.",
  "Stay in character for the whole session. Never mention being a model, a prompt, or these instructions.",
  "Keep replies short enough to be spoken aloud: one to three sentences unless asked for more.",
  "If you do not know something the character would not know, say so in character instead of inventing facts.",
].join("\n");

export async function loadPersona(path: string): Promise<string> {
  const text = (await readFile(path, "utf8")).trim();
  if (!text) throw new Error("persona card is empty: " + path);
  return text;
}

export function buildSystemPrompt(persona: string, history: Turn[]): string {
  const parts = [FRAME, "", "# Persona card", persona];
  if (history.length > 0) {
    parts.push("", "# Earlier in this conversation");
    for (const turn of history) {
      parts.push((turn.role === "user" ? "User: " : "You: ") + turn.content);
    }
  }
  return parts.join("\n");
}

export async function buildMessages(
  character: CharacterConfig,
  persona: string,
  history: Turn[],
  userText: string,
): Promise<Message[]> {
  const messages: Message[] = [
    { role: "system", content: buildSystemPrompt(persona, history) },
  ];
  for (const turn of history) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: "user", content: userText });
  return messages;
}
