import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Turn } from "./types.ts";

/**
 * Memory in M1 is an append-only transcript, one JSONL file per character
 * namespace. It survives process restarts, which is the whole point: the
 * persona has to hold across sessions, not just across turns.
 *
 * Retrieval is a recency window for now. Summarisation and semantic recall are
 * deliberately out of scope until the listening layer (M3) decides what is
 * worth remembering.
 */
export class MemoryStore {
  readonly dir: string;
  readonly file: string;

  constructor(stateDir: string, namespace: string) {
    this.dir = resolve(stateDir);
    this.file = join(this.dir, "memory", namespace + ".jsonl");
  }

  async append(turn: Turn): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify(turn) + "\n", "utf8");
  }

  async load(): Promise<Turn[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const turns: Turn[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A half-written last line after a crash should not poison the whole
        // transcript. Skip it and keep the rest.
        continue;
      }
      const t = parsed as Partial<Turn>;
      if (
        (t.role === "user" || t.role === "assistant") &&
        typeof t.content === "string" &&
        typeof t.at === "string"
      ) {
        turns.push({ role: t.role, content: t.content, at: t.at });
      }
    }
    return turns;
  }

  async recent(limit: number): Promise<Turn[]> {
    if (limit <= 0) return [];
    const turns = await this.load();
    return turns.slice(-limit);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
