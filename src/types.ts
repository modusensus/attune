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
 * Engine states. M1 only drives them as markers; M2 (voice) and M3 (listening
 * layer) are the ones that actually put audio behind them.
 */
export type EngineState = "listening" | "thinking" | "speaking";

export type EngineEvent =
  | { type: "state"; state: EngineState }
  | { type: "delta"; text: string }
  | { type: "reply"; text: string };

export interface CharacterConfig {
  name: string;
  personaPath: string;
  memoryNamespace: string;
  voice: { engine: string; model: string };
  renderer: { type: string; model: string };
  mapping: Record<string, string | number | boolean | Array<string | number>>;
  rootDir: string;
}
