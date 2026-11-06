import { MemoryStore, nowIso } from "./memory.ts";
import { buildMessages, loadPersona } from "./persona.ts";
import { mouthFrames, type EnvelopeOptions } from "./audio/envelope.ts";
import type { Provider } from "./provider.ts";
import { SilentSpeech, type SpeechProvider } from "./speech.ts";
import type { CharacterConfig, EngineEvent, Turn } from "./types.ts";

export interface EngineOptions {
  character: CharacterConfig;
  provider: Provider;
  speech?: SpeechProvider;
  stateDir: string;
  historyLimit?: number;
  persona?: string;
  /** Passed through to the mouth envelope; renderers differ in what they like. */
  envelope?: EnvelopeOptions;
  /** Synthesize speech at all. Off keeps M1 behaviour exactly. */
  voice?: boolean;
}

/**
 * The text loop, with an optional voice attached. One user utterance in, a
 * character reply out, and — when a speech engine is configured — the audio and
 * the mouth curve that goes with it.
 *
 * The engine still knows nothing about renderers. It emits a frame list; what
 * anyone does with it is their business.
 */
export class Engine {
  readonly character: CharacterConfig;
  readonly provider: Provider;
  readonly speech: SpeechProvider;
  readonly memory: MemoryStore;
  private readonly historyLimit: number;
  private readonly envelope: EnvelopeOptions;
  private readonly voiceEnabled: boolean;
  private persona: string | null;

  constructor(options: EngineOptions) {
    this.character = options.character;
    this.provider = options.provider;
    this.speech = options.speech ?? new SilentSpeech();
    this.memory = new MemoryStore(options.stateDir, options.character.memoryNamespace);
    this.historyLimit = options.historyLimit ?? 12;
    this.envelope = options.envelope ?? {};
    this.voiceEnabled = options.voice ?? true;
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
    for await (const delta of this.provider.stream(messages, signal)) {
      if (!announced) {
        announced = true;
        yield { type: "state", state: "speaking" };
      }
      reply += delta;
      yield { type: "delta", text: delta };
    }

    const finalText = reply.trim();
    if (!finalText) throw new Error("provider produced an empty reply");

    // The reply is committed before it is spoken: a speech engine that fails
    // must not cost us the transcript, and the mouth curve is derived from
    // whatever audio we actually got.
    await this.memory.append({ role: "assistant", content: finalText, at: nowIso() });

    if (this.voiceEnabled) {
      const clip = await this.speech.speak(finalText, signal);
      // No second "speaking" transition: the text already put us there, and a
      // duplicate state would make every renderer's transition table lie.
      yield {
        type: "speech",
        engine: clip.engine,
        text: clip.text,
        durationMs: clip.audio.durationMs,
        audio: clip.audio,
      };
      yield { type: "mouth", frames: mouthFrames(clip.audio, this.envelope) };
    }

    yield { type: "state", state: "listening" };
    yield { type: "reply", text: finalText };
  }
}
