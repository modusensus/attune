import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseToml, type TomlTable, type TomlValue } from "./toml.ts";
import type { CharacterConfig } from "./types.ts";

export const CHARACTER_FILE = "character.toml";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function table(root: TomlTable, key: string, required: boolean): TomlTable {
  const v = root[key];
  if (v === undefined) {
    if (required) throw new ConfigError("missing [" + key + "] table");
    return {};
  }
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new ConfigError("[" + key + "] must be a table");
  }
  return v;
}

function str(t: TomlTable, key: string, section: string, fallback?: string): string {
  const v = t[key];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new ConfigError("[" + section + "] missing " + key);
  }
  if (typeof v !== "string") throw new ConfigError("[" + section + "] " + key + " must be a string");
  if (!v.trim()) throw new ConfigError("[" + section + "] " + key + " is empty");
  return v;
}

function optStr(t: TomlTable, key: string, section: string): string | undefined {
  const v = t[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ConfigError("[" + section + "] " + key + " must be a string");
  return v;
}

function optInt(t: TomlTable, key: string, section: string): number | undefined {
  const v = t[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new ConfigError("[" + section + "] " + key + " must be an integer");
  }
  return v;
}

function mappingOf(t: TomlTable): Record<string, string | number | boolean | Array<string | number>> {
  const out: Record<string, string | number | boolean | Array<string | number>> = {};
  for (const [k, v] of Object.entries(t)) {
    if (typeof v === "object" && !Array.isArray(v)) {
      throw new ConfigError("[mapping] " + k + " must be a scalar or a flat array");
    }
    out[k] = v as TomlValue;
  }
  return out;
}

function resolveInside(rootDir: string, path: string, field: string): string {
  const abs = isAbsolute(path) ? path : resolve(rootDir, path);
  return abs;
}

export async function loadCharacter(dir: string): Promise<CharacterConfig> {
  const rootDir = resolve(dir);
  const file = join(rootDir, CHARACTER_FILE);
  if (!existsSync(file)) throw new ConfigError("no " + CHARACTER_FILE + " in " + rootDir);

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    throw new ConfigError("cannot read " + file + ": " + (err as Error).message);
  }

  const root = parseToml(text);
  const identity = table(root, "identity", true);
  const voice = table(root, "voice", false);
  const renderer = table(root, "renderer", false);
  const mapping = table(root, "mapping", false);

  const name = str(identity, "name", "identity");
  const personaPath = resolveInside(rootDir, str(identity, "persona", "identity"), "persona");
  if (!existsSync(personaPath)) {
    throw new ConfigError("persona file not found: " + personaPath);
  }

  return {
    name,
    personaPath,
    memoryNamespace: str(identity, "memory_namespace", "identity", name),
    voice: {
      engine: str(voice, "engine", "voice", "none"),
      model: str(voice, "model", "voice", "none"),
      voice: optStr(voice, "voice", "voice"),
      rate: optInt(voice, "rate", "voice"),
    },
    renderer: {
      type: str(renderer, "type", "renderer", "none"),
      model: str(renderer, "model", "renderer", "none"),
    },
    mapping: mappingOf(mapping),
    rootDir,
  };
}