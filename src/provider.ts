import type { Message } from "./types.ts";

/**
 * One seam for the language model. Nothing above this line knows whether the
 * model is a local llama.cpp server, LM Studio, or a hosted endpoint: they all
 * speak the OpenAI-compatible chat-completions protocol, and anything else can
 * implement this interface.
 *
 * attune ships no model and downloads none. With no endpoint configured the
 * engine still runs, using the offline provider, so the loop can be exercised
 * on a machine that has never installed a model.
 */
export interface Provider {
  readonly id: string;
  stream(messages: Message[], signal?: AbortSignal): AsyncIterable<string>;
}

export interface HttpProviderOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  private readonly opts: Required<Omit<HttpProviderOptions, "apiKey">> & { apiKey?: string };

  constructor(options: HttpProviderOptions) {
    if (!options.baseUrl) throw new ProviderError("baseUrl is required");
    if (!options.model) throw new ProviderError("model is required");
    this.opts = {
      baseUrl: trimSlash(options.baseUrl),
      model: options.model,
      apiKey: options.apiKey,
      temperature: options.temperature ?? 0.7,
      maxTokens: options.maxTokens ?? 400,
      timeoutMs: options.timeoutMs ?? 30000,
    };
    this.id = "http:" + this.opts.model;
  }

  async *stream(messages: Message[], signal?: AbortSignal): AsyncIterable<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    const forward = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", forward, { once: true });
    }

    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.opts.apiKey) headers.authorization = "Bearer " + this.opts.apiKey;

      let res: Response;
      try {
        res = await fetch(this.opts.baseUrl + "/chat/completions", {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: this.opts.model,
            messages,
            temperature: this.opts.temperature,
            max_tokens: this.opts.maxTokens,
            stream: true,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        throw new ProviderError(
          "cannot reach " + this.opts.baseUrl + " (" + (err as Error).message + "). " +
            "Is a local model server running, or is ATTUNE_BASE_URL set?",
        );
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new ProviderError(
          "provider returned HTTP " + res.status + (body ? ": " + body.slice(0, 300) : ""),
        );
      }
      if (!res.body) throw new ProviderError("provider returned an empty body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") return;
          let chunk: any;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) yield delta;
        }
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", forward);
    }
  }
}

/**
 * Offline provider. It answers in character-agnostic filler that is obviously
 * not a real model, so a missing endpoint shows up as a visibly hollow
 * conversation rather than as a hang or a crash.
 */
export class OfflineProvider implements Provider {
  readonly id = "offline";

  async *stream(messages: Message[]): AsyncIterable<string> {
    const last = messages[messages.length - 1];
    const heard = last && last.role === "user" ? last.content : "";
    yield "（离线模式：没有配置模型端点）";
    if (heard) yield " 我听到你说：" + heard.slice(0, 40);
  }
}

export interface ProviderConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

/** Reads the environment once, at the edge, so the rest of the engine is pure. */
export function providerFromEnv(env: Record<string, string | undefined>): Provider {
  const baseUrl = env.ATTUNE_BASE_URL?.trim();
  const model = env.ATTUNE_MODEL?.trim();
  if (!baseUrl || !model) return new OfflineProvider();
  return new OpenAICompatibleProvider({
    baseUrl,
    model,
    apiKey: env.ATTUNE_API_KEY?.trim(),
  });
}
