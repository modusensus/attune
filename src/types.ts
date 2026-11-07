import type { WavAudio } from "./audio/wav.ts";
import type { MouthFrame } from "./audio/envelope.ts";
import type { Gesture } from "./render/gesture.ts";

export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
  at: string;
}

/**
 * Engine states. M1 drove them as markers; from M2 on, "speaking" has audio and
 * a mouth curve behind it, and M3 is the one that puts the listening layer
 * behind "listening".
 */
export type EngineState = "listening" | "thinking" | "speaking";

export type EngineEvent =
  | { type: "state"; state: EngineState }
  | { type: "delta"; text: string }
  | { type: "reply"; text: string }
  | { type: "speech"; engine: string; text: string; durationMs: number; audio: WavAudio }
  | { type: "mouth"; frames: MouthFrame[] }
  | { type: "silent-turn"; reason: string }
  /** Non-verbal reactions the listening layer decided on while the user spoke. */
  | { type: "gesture"; gestures: Gesture[] }
  /** The user talked over the character and the reply audio should stop. */
  | { type: "barge-in"; at: number; rms: number };

export interface CharacterConfig {
  name: string;
  personaPath: string;
  memoryNamespace: string;
  voice: { engine: string; model: string; voice?: string; rate?: number };
  renderer: { type: string; model: string };
  mapping: Record<string, string | number | boolean | Array<string | number>>;
  rootDir: string;
}