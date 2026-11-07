import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGlb, asArray, asObject } from "../src/render/vrm/glb.ts";
import { buildGlb } from "./fixtures/vrm-build.ts";

const minimal = { asset: { version: "2.0" } };

test("a well-formed GLB yields its JSON and its byte count", () => {
  const bytes = buildGlb({ json: minimal });
  const glb = parseGlb(bytes, "sample");
  assert.equal(glb.version, 2);
  assert.equal(glb.bytes, bytes.byteLength);
  assert.deepEqual(glb.json, minimal);
  assert.equal(glb.bin, null, "no BIN chunk in a file that has none");
});

test("a BIN chunk is carried through untouched", () => {
  const bin = new Uint8Array([1, 2, 3, 4, 5]);
  const glb = parseGlb(buildGlb({ json: minimal, bin }), "sample");
  assert.ok(glb.bin);
  assert.equal(glb.bin.byteLength, 8, "the chunk is padded to a multiple of four");
  assert.deepEqual([...glb.bin.subarray(0, 5)], [1, 2, 3, 4, 5], "padding goes after the data");
});

test("JSON padding is trimmed, not parsed as part of the document", () => {
  // The builder pads with spaces; a real exporter may pad with NULs.
  const bytes = buildGlb({ json: { asset: { version: "2.0" }, note: "x" } });
  const glb = parseGlb(bytes, "sample");
  assert.equal((glb.json as { note: string }).note, "x");
});

test("the magic number is checked", () => {
  const bytes = buildGlb({ json: minimal, magic: 0x12345678 });
  assert.throws(() => parseGlb(bytes, "sample"), /does not start with the glTF magic number/);
});

test("only GLB version 2 is accepted", () => {
  const bytes = buildGlb({ json: minimal, version: 1 });
  assert.throws(() => parseGlb(bytes, "sample"), /is GLB version 1; only version 2 is supported/);
});

test("a truncated file is named as truncated, not as corrupt JSON", () => {
  const bytes = buildGlb({ json: minimal, declaredLength: 99999 });
  assert.throws(() => parseGlb(bytes, "sample"), /says it is 99999 bytes but \d+ arrived; the file is truncated or padded/);
});

test("a file too short to hold a header says so", () => {
  assert.throws(() => parseGlb(new Uint8Array([0x67, 0x6c, 0x54]), "sample"), /too short to be a GLB file/);
});

test("a chunk that runs past the end of the file is caught before it is read", () => {
  const bytes = buildGlb({ json: minimal });
  // Rewrite the first chunk length to something impossible.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(12, 100000, true);
  assert.throws(() => parseGlb(bytes, "sample"), /chunk 0 claims 100000 bytes but only \d+ remain/);
});

test("a file with no JSON chunk has no glTF in it", () => {
  // A well-formed container whose only chunk is BIN.
  const bin = new Uint8Array([0, 0, 0, 0]);
  const chunk = new Uint8Array(8 + bin.byteLength);
  const cv = new DataView(chunk.buffer);
  cv.setUint32(0, bin.byteLength, true);
  cv.setUint32(4, 0x004e4942, true);
  chunk.set(bin, 8);
  const out = new Uint8Array(12 + chunk.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.byteLength, true);
  out.set(chunk, 12);
  assert.throws(() => parseGlb(out, "sample"), /has no JSON chunk/);
});

test("an unknown chunk type is skipped, as the spec requires", () => {
  const jsonChunkBody = new TextEncoder().encode(JSON.stringify(minimal));
  const pad = (body: Uint8Array, fill: number) => {
    const rem = body.byteLength % 4;
    if (rem === 0) return body;
    const grown = new Uint8Array(body.byteLength + 4 - rem);
    grown.set(body);
    grown.fill(fill, body.byteLength);
    return grown;
  };
  const makeChunk = (body: Uint8Array, type: number) => {
    const head = new Uint8Array(8);
    const view = new DataView(head.buffer);
    view.setUint32(0, body.byteLength, true);
    view.setUint32(4, type, true);
    const out = new Uint8Array(8 + body.byteLength);
    out.set(head);
    out.set(body, 8);
    return out;
  };
  const parts = [
    makeChunk(pad(jsonChunkBody, 0x20), 0x4e4f534a),
    makeChunk(pad(new Uint8Array([9, 9, 9, 9]), 0), 0x41505031),
  ];
  const total = 12 + parts.reduce((s, p) => s + p.byteLength, 0);
  const file = new Uint8Array(total);
  const fv = new DataView(file.buffer);
  fv.setUint32(0, 0x46546c67, true);
  fv.setUint32(4, 2, true);
  fv.setUint32(8, total, true);
  let at = 12;
  for (const p of parts) {
    file.set(p, at);
    at += p.byteLength;
  }
  const glb = parseGlb(file, "sample");
  assert.deepEqual(glb.json, minimal, "the unknown chunk did not disturb the JSON");
});

test("a JSON chunk that does not parse blames the chunk, not the file", () => {
  const body = padBytes(new TextEncoder().encode("{ not json"));
  const chunk = chunkOf(body, 0x4e4f534a);
  assert.throws(() => parseGlb(wrap([chunk]), "sample"), /JSON chunk that does not parse/);
});

test("a JSON chunk holding an array is not a glTF document", () => {
  const body = padBytes(new TextEncoder().encode("[1,2,3]"));
  const chunk = chunkOf(body, 0x4e4f534a);
  assert.throws(() => parseGlb(wrap([chunk]), "sample"), /JSON chunk that is not an object/);
});

test("an empty JSON chunk is reported as empty", () => {
  const chunk = chunkOf(padBytes(new TextEncoder().encode("   ")), 0x4e4f534a);
  assert.throws(() => parseGlb(wrap([chunk]), "sample"), /empty JSON chunk/);
});

test("asArray and asObject narrow instead of throwing", () => {
  assert.deepEqual(asArray([1, 2]), [1, 2]);
  assert.deepEqual(asArray(undefined), []);
  assert.deepEqual(asArray({ a: 1 }), [], "an object is not an array");
  assert.deepEqual(asObject({ a: 1 }), { a: 1 });
  assert.deepEqual(asObject([1]), {});
  assert.deepEqual(asObject("x"), {});
  assert.deepEqual(asObject(null), {});
});

function padBytes(body: Uint8Array): Uint8Array {
  const rem = body.byteLength % 4;
  if (rem === 0) return body;
  const grown = new Uint8Array(body.byteLength + 4 - rem);
  grown.set(body);
  grown.fill(0x20, body.byteLength);
  return grown;
}

function chunkOf(body: Uint8Array, type: number): Uint8Array {
  const head = new Uint8Array(8);
  const view = new DataView(head.buffer);
  view.setUint32(0, body.byteLength, true);
  view.setUint32(4, type, true);
  const out = new Uint8Array(8 + body.byteLength);
  out.set(head);
  out.set(body, 8);
  return out;
}

function wrap(chunks: Uint8Array[]): Uint8Array {
  const total = 12 + chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  let at = 12;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
