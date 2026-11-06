import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { OpenAICompatibleProvider, OfflineProvider, ProviderError, providerFromEnv } from "../src/provider.ts";
import type { Message } from "../src/types.ts";

const MESSAGES: Message[] = [{ role: "user", content: "在吗" }];

async function withServer(
  handler: (req: { url: string; body: string; headers: Record<string, string | string[] | undefined> }, res: any) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler({ url: req.url ?? "", body, headers: req.headers }, res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn("http://127.0.0.1:" + port + "/v1");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function sse(res: any, chunks: string[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of chunks) res.write(c);
  res.end();
}

test("streams deltas from an OpenAI-compatible SSE response", async () => {
  await withServer(
    (_req, res) => {
      sse(res, [
        'data: {"choices":[{"delta":{"content":"嗯"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"。"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    },
    async (baseUrl) => {
      const provider = new OpenAICompatibleProvider({ baseUrl, model: "fake" });
      const out: string[] = [];
      for await (const d of provider.stream(MESSAGES)) out.push(d);
      assert.deepEqual(out, ["嗯", "。"]);
    },
  );
});

test("sends the model, the messages and the auth header", async () => {
  let seen: any = null;
  await withServer(
    (req, res) => {
      seen = { body: JSON.parse(req.body), headers: req.headers };
      sse(res, ["data: [DONE]\n\n"]);
    },
    async (baseUrl) => {
      const provider = new OpenAICompatibleProvider({ baseUrl, model: "fake", apiKey: "secret" });
      for await (const _ of provider.stream(MESSAGES)) void _;
      assert.equal(seen.body.model, "fake");
      assert.equal(seen.body.stream, true);
      assert.deepEqual(seen.body.messages, MESSAGES);
      assert.equal(seen.headers.authorization, "Bearer secret");
    },
  );
});

test("a non-2xx response becomes a ProviderError carrying the body", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("model not loaded");
    },
    async (baseUrl) => {
      const provider = new OpenAICompatibleProvider({ baseUrl, model: "fake" });
      await assert.rejects(
        async () => {
          for await (const _ of provider.stream(MESSAGES)) void _;
        },
        (err: unknown) => err instanceof ProviderError && /HTTP 500/.test(err.message) && /model not loaded/.test(err.message),
      );
    },
  );
});

test("a refused connection explains how to fix it", async () => {
  const provider = new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:1/v1", model: "fake" });
  await assert.rejects(
    async () => {
      for await (const _ of provider.stream(MESSAGES)) void _;
    },
    (err: unknown) => err instanceof ProviderError && /ATTUNE_BASE_URL/.test(err.message),
  );
});

test("malformed chunks are skipped rather than aborting the stream", async () => {
  await withServer(
    (_req, res) => {
      sse(res, [
        "data: {not json}\n\n",
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    },
    async (baseUrl) => {
      const provider = new OpenAICompatibleProvider({ baseUrl, model: "fake" });
      const out: string[] = [];
      for await (const d of provider.stream(MESSAGES)) out.push(d);
      assert.deepEqual(out, ["ok"]);
    },
  );
});

test("trailing slashes in baseUrl do not double up the path", async () => {
  let path = "";
  await withServer(
    (req, res) => {
      path = req.url;
      sse(res, ["data: [DONE]\n\n"]);
    },
    async (baseUrl) => {
      const provider = new OpenAICompatibleProvider({ baseUrl: baseUrl + "///", model: "fake" });
      for await (const _ of provider.stream(MESSAGES)) void _;
      assert.equal(path, "/v1/chat/completions");
    },
  );
});

test("the offline provider answers without any endpoint", async () => {
  const provider = new OfflineProvider();
  const out: string[] = [];
  for await (const d of provider.stream([{ role: "user", content: "在吗" }])) out.push(d);
  assert.ok(out.join("").includes("离线"));
});

test("the environment decides whether a model is configured", () => {
  assert.equal(providerFromEnv({}).id, "offline");
  assert.equal(providerFromEnv({ ATTUNE_BASE_URL: "http://x/v1" }).id, "offline");
  assert.equal(providerFromEnv({ ATTUNE_MODEL: "m" }).id, "offline");
  assert.equal(
    providerFromEnv({ ATTUNE_BASE_URL: "http://x/v1", ATTUNE_MODEL: "m" }).id,
    "http:m",
  );
});
