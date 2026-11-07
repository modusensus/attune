/**
 * GLB container parsing. A .vrm file is a .glb file: a twelve-byte header and a
 * sequence of chunks, the first of which is the glTF JSON and the second the
 * binary buffer.
 *
 * Nothing here reads a mesh. The renderer needs the node tree and the
 * expression table; geometry, materials and animation are the host page's
 * problem, and three.js already does them better than anything written here
 * would.
 */

const MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN" followed by a NUL

export type GltfJson = Record<string, unknown>;

export interface GlbFile {
  /** The parsed glTF JSON chunk. */
  json: GltfJson;
  /** The binary chunk, when the file has one. Never interpreted here. */
  bin: Uint8Array | null;
  /** Container version, which is 2 for every VRM file in practice. */
  version: number;
  /** Total bytes, kept for the report so a truncated download is obvious. */
  bytes: number;
}

export class GlbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlbError";
  }
}

/** Narrow a possibly-absent JSON member to an array. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Narrow a possibly-absent JSON member to an object. */
export function asObject(value: unknown): GltfJson {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as GltfJson;
  return {};
}

export function parseGlb(bytes: Uint8Array, label = "model"): GlbFile {
  if (bytes.byteLength < 12) {
    throw new GlbError(label + " is only " + bytes.byteLength + " bytes: too short to be a GLB file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new GlbError(
      label + " does not start with the glTF magic number (0x" + magic.toString(16) + "); is it a .glb/.vrm?",
    );
  }

  const version = view.getUint32(4, true);
  if (version !== 2) {
    throw new GlbError(label + " is GLB version " + version + "; only version 2 is supported");
  }

  const declared = view.getUint32(8, true);
  if (declared !== bytes.byteLength) {
    throw new GlbError(
      label + " says it is " + declared + " bytes but " + bytes.byteLength +
        " arrived; the file is truncated or padded",
    );
  }

  let json: GltfJson | null = null;
  let bin: Uint8Array | null = null;
  let offset = 12;
  let index = 0;

  while (offset + 8 <= declared) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    if (end > declared) {
      throw new GlbError(
        label + ": chunk " + index + " claims " + length + " bytes but only " + (declared - start) + " remain",
      );
    }
    const body = bytes.subarray(start, end);

    if (type === CHUNK_JSON) {
      if (json) throw new GlbError(label + " has more than one JSON chunk");
      json = parseJsonChunk(body, label);
    } else if (type === CHUNK_BIN) {
      if (bin) throw new GlbError(label + " has more than one BIN chunk");
      bin = body;
    }
    // Unknown chunk types are skipped on purpose: the spec says a reader must
    // ignore what it does not understand.

    offset = end;
    index += 1;
  }

  if (!json) throw new GlbError(label + " has no JSON chunk, so there is no glTF in it");

  return { json, bin, version, bytes: bytes.byteLength };
}

function parseJsonChunk(body: Uint8Array, label: string): GltfJson {
  // JSON chunks are padded with spaces; BIN chunks with zeroes. Trim both.
  let end = body.byteLength;
  while (end > 0 && (body[end - 1] === 0x20 || body[end - 1] === 0x00)) end -= 1;
  const text = new TextDecoder("utf-8").decode(body.subarray(0, end));
  if (!text.trim()) throw new GlbError(label + " has an empty JSON chunk");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new GlbError(label + " has a JSON chunk that does not parse: " + (err as Error).message);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GlbError(label + " has a JSON chunk that is not an object");
  }
  return parsed as GltfJson;
}
