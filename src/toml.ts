/**
 * A deliberately small TOML reader.
 *
 * attune is meant to be run straight from a clone with no install step, so it
 * carries no dependencies. character.toml only ever uses a tiny slice of TOML:
 * tables, bare keys, strings, numbers, booleans and flat arrays. Everything
 * else fails loudly instead of being silently ignored.
 */

export type TomlValue = string | number | boolean | Array<string | number>;
export type TomlTable = { [key: string]: TomlValue | TomlTable };

function stripComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") {
        i++;
      } else if (c === quote) {
        quote = "";
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseString(raw: string, where: string): string {
  const quote = raw[0];
  if (raw[raw.length - 1] !== quote || raw.length < 2) {
    throw new Error("unterminated string at " + where);
  }
  const body = raw.slice(1, -1);
  if (quote === "'") return body;
  return body
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function splitArray(body: string): string[] {
  const out: string[] = [];
  let quote = "";
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      cur += c;
      if (c === "\\") {
        if (i + 1 < body.length) {
          cur += body[i + 1];
          i++;
        }
      } else if (c === quote) {
        quote = "";
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function parseValue(raw: string, where: string): TomlValue {
  const v = raw.trim();
  if (!v) throw new Error("empty value at " + where);
  if (v.startsWith('"') || v.startsWith("'")) return parseString(v, where);
  if (v.startsWith("[")) {
    if (!v.endsWith("]")) throw new Error("unterminated array at " + where);
    const items = splitArray(v.slice(1, -1));
    return items.map((item) => parseValue(item, where)) as Array<string | number>;
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^[+-]?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (/^[+-]?\d+\.\d+$/.test(v)) return Number.parseFloat(v);
  throw new Error("unsupported value " + JSON.stringify(v) + " at " + where);
}

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  const declared = new Set<string>();
  let table: TomlTable = root;

  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const where = "line " + (n + 1);
    const line = stripComment(lines[n]).trim();
    if (!line) continue;

    if (line.startsWith("[")) {
      if (!line.endsWith("]")) throw new Error("unterminated table header at " + where);
      if (line.startsWith("[[")) {
        throw new Error("array-of-tables is not supported at " + where);
      }
      const tableName = line.slice(1, -1).trim();
      if (!tableName) throw new Error("empty table name at " + where);
      if (declared.has(tableName)) {
        throw new Error("table [" + tableName + "] is declared twice (" + where + ")");
      }
      declared.add(tableName);
      let cur: TomlTable = root;
      for (const part of tableName.split(".")) {
        const key = part.trim();
        if (!key) throw new Error("empty table segment at " + where);
        const existing = cur[key];
        if (existing === undefined) {
          const next: TomlTable = {};
          cur[key] = next;
          cur = next;
        } else if (typeof existing === "object" && !Array.isArray(existing)) {
          cur = existing;
        } else {
          throw new Error("key " + key + " is already a value, not a table (" + where + ")");
        }
      }
      table = cur;
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) throw new Error("expected key = value at " + where);
    const key = line.slice(0, eq).trim();
    if (!key) throw new Error("empty key at " + where);
    if (key.includes(".")) {
      throw new Error("dotted keys are not supported at " + where + " (use [table] headers)");
    }
    table[key] = parseValue(line.slice(eq + 1), where);
  }

  return root;
}
