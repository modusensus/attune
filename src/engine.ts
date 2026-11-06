import { MemoryStore, nowIso } from "./memory.ts";
import { buildMessages, loadPersona } from "./persona.ts";
import type { Provider } from "./provider.ts";
import type { CharacterConfig, EngineEvent, Turn } from "./types.ts";

export interface EngineOptions {
  character: CharacterConfig;
  provider: Provider;
  stateDir: string;
  historyLimit?: number;
  persona?: string;
}

/**
 * The text loop. One user utterance in, a character reply out, with the state
 * transitions surfaced as events so a renderer (later) and a test (now) can
 * observe them without the engine knowing what a renderer is.
 */
export class Engine {
  readonly character: CharacterConfig;
  readonly provider: Provider;
  readonly memory: MemoryStore;
  private readonly historyLimit: number;
  private persona: string | null;

  constructor(options: EngineOptions) {
    this.character = options.character;
    this.provider = options.provider;
    this.memory = new MemoryStore(options.stateDir, options.character.memoryNamespace);
    this.historyLimit = options.historyLimit ?? 12;
    this.persona = options.persona ?? null;
  }

  private async personaText(): Promise<string> {
    if (!this.persona) this.persona = await loadPersona(this.character.personaPath);
    return this.persona;
  }

  async *turn(userText: string, signal?: AbortSignal): AsyncIterable<EngineEvent> {
    const text = userText.trim();
    if (!text) throw new Error("empty utterance");

    yield { type: "state", state: "listening" };

    const history: Turn[] = await this.memory.recent(this.historyLimit);
    const persona = await this.personaText();
    const messages = await buildMessages(this.character, persona, history, text);

    yield { type: "state", state: "thinking" };

    const userTurn: Turn = { role: "user", content: text, at: nowIso() };
    await this.memory.append(userTurn);

    let reply = "";
    let announced = false;
    try {
      for await (const delta of this.provider.stream(messages, signal)) {
        if (!announced) {
          announced = true;
          yield { type: "state", state: "speaking" };
        }
        reply += delta;
        yield { type: "delta", text: delta };
      }
    } catch (err) {
      // The user's turn is already on disk; a failed reply must not leave the
      // transcript looking like a one-sided conversation, so nothing else is
      // written and the error is surfaced to the caller.
      throw err;
    }

    const finalText = reply.trim();
    if (!finalText) throw new Error("provider produced an empty reply");

    await this.memory.append({ role: "assistant", content: finalText, at: nowIso() });
    yield { type: "state", state: "listening" };
    yield { type: "reply", text: finalText };
  }
}
