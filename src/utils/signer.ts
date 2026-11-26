import { createHmac, createHash } from "node:crypto";
import { isOpengwModel } from "./opengw.js";
import { guardChatResponse } from "./sse.js";
import {
  applyImageBudget,
  type CaptionFn,
  type ImageBudgetOptions,
} from "./body-budget.js";
import {
  createImageCompressor,
  type ImageCompressor,
} from "./image-compress.js";

export { MAX_CHAT_BODY_BYTES } from "./body-budget.js";

/** Shared so the compressed-image cache survives across requests. Null when
 * the runtime has no Bun.Image (the default caption path then applies). */
const sharedImageCompressor: ImageCompressor | null = createImageCompressor();

const enc = encodeURIComponent;
const rfc3986 = (s: string): string =>
  enc(String(s))
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");

const sha256hex = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

export function sdkDate(d: Date = new Date()): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

export type Headers = Record<string, string>;

/**
 * Huawei Cloud APIG SDK-HMAC-SHA256 request signing.
 * Returns headers to merge into the outgoing request.
 */
export function signRequest(
  method: string,
  url: string,
  ak: string,
  sk: string,
  extraHeaders: Headers = {},
  body: string = "",
): Headers {
  const u = new URL(url);
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQuery = query.map(([k, v]) => `${k}=${v}`).join("&");

  let canonicalPath = decodeURIComponent(u.pathname) || "/";
  if (!canonicalPath.endsWith("/")) canonicalPath += "/";

  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (v !== undefined && v !== null && String(v).trim() !== "")
      h[k.toLowerCase()] = String(v).trim();
  }
  h["host"] = u.host;
  h["x-sdk-date"] = sdkDate();
  const names = Object.keys(h).sort();
  const canonicalHeaders = names.map((n) => `${n}:${h[n]}\n`).join("");
  const signedHeaders = names.join(";");

  const payload = typeof body === "string" ? body : (body ?? "");
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    sha256hex(Buffer.from(payload, "utf8")),
  ].join("\n");

  const stringToSign = [
    "SDK-HMAC-SHA256",
    h["x-sdk-date"],
    sha256hex(canonicalRequest),
  ].join("\n");
  const signature = createHmac("sha256", sk).update(stringToSign).digest("hex");

  return {
    ...extraHeaders,
    "X-Sdk-Date": h["x-sdk-date"],
    Authorization: `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

const uuidHex = (): string => crypto.randomUUID().replace(/-/g, "");

const CHAT_PATH_RE = /\/api\/v2\/chat\/completions\/?$/;

export const isChatCompletionsUrl = (url: string): boolean =>
  CHAT_PATH_RE.test(url);

/** Per-process pseudo session id, mirrors one TUI chat session. */
export function randomSessionId(): string {
  return `ses_${Math.random().toString(36).slice(2, 11)}${Date.now().toString(36)}`;
}

/** Collect request headers (HeadersInit or Request) into a plain record,
 * case-insensitively deduped, dropping `authorization` (the SDK's Bearer
 * header must never reach the gateway — see AGENTS.md "APIG.0301"). */
export function collectHeaders(
  src?: HeadersInit | Request,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!src) return out;
  const headers = src instanceof Request ? src.headers : new Headers(src);
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "authorization") return;
    out[key] = value;
  });
  return out;
}

/** Case-insensitive header merge; later values win so the same header is
 * never sent twice with different values (signed once, sent twice = 401). */
export function mergeHeaders(
  ...sources: Record<string, string>[]
): Record<string, string> {
  const merged: Record<string, string> = {};
  const lowerToKey = new Map<string, string>();
  for (const source of sources) {
    for (const [k, v] of Object.entries(source)) {
      const lower = k.toLowerCase();
      const existing = lowerToKey.get(lower);
      if (existing !== undefined) delete merged[existing];
      merged[k] = v;
      lowerToKey.set(lower, k);
    }
  }
  return merged;
}

/** CLI body shape: streaming + tool_stream + last user turn echoed as
 * `user_prompt`. Returns the parsed JSON and the routing model id. */
function parseCliBody(bodyStr: string): {
  parsed: Record<string, unknown>;
  model: string;
} {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = bodyStr ? JSON.parse(bodyStr) : {};
  } catch {
    parsed = {};
  }
  const model = typeof parsed.model === "string" ? parsed.model : "";
  // Hosts may inject max-token fields
  // opencode v2.0.25 sends max_completion_tokens: <limit.output>`).
  // InferHub rejects both `max_completion_tokens` AND `max_tokens` with
  // `InferHub.001001005.400 The request param is invalid`.
  delete parsed.max_completion_tokens;
  delete parsed.max_tokens;
  parsed.stream = true;
  parsed.tool_stream = parsed.tool_stream ?? true;
  if (!Array.isArray(parsed.messages)) parsed.messages = [];
  const lastUser = [...(parsed.messages as { role?: string }[])]
    .reverse()
    .find((m) => m?.role === "user");
  const lastText =
    lastUser && typeof lastUser === "object"
      ? ((lastUser as { content?: unknown }).content ?? "")
      : "";
  // Multimodal turns carry an array of parts (text + image_url): echo the
  // text parts joined, like the CLI does — an empty user_prompt is a
  // different request shape than any the CLI ever sends.
  parsed.user_prompt =
    typeof parsed.user_prompt === "string"
      ? parsed.user_prompt
      : typeof lastText === "string"
        ? lastText
        : Array.isArray(lastText)
          ? lastText
              .filter(
                (p) =>
                  p &&
                  typeof p === "object" &&
                  (p as { type?: string }).type === "text",
              )
              .map((p) => String((p as { text?: unknown }).text ?? ""))
              .filter(Boolean)
              .join("\n")
          : "";
  return { parsed, model };
}

function serializeCliBody(
  parsed: Record<string, unknown>,
  model: string,
): { body: string; model: string } {
  return { body: JSON.stringify(parsed), model };
}

/** Sync shape without the image-budget pass (tests/tools). Real requests use
 * the async variant: over the watermark, old-turn images are captioned by
 * default or WebP-compressed when `compressImages` is on. */
export function applyCliBodyShape(bodyStr: string): {
  body: string;
  model: string;
} {
  const { parsed, model } = parseCliBody(bodyStr);
  return serializeCliBody(parsed, model);
}

export type ChatBodyBudget = Pick<
  ImageBudgetOptions,
  "caption" | "store" | "compress"
>;

/** Shapes a chat body and applies the cache-aware image budget: replay cached
 * captions/compressions, then either caption (default) or compress
 * (`compressImages`); the current turn stays native. */
async function applyCliBodyShapeWithBudget(
  bodyStr: string,
  budget: ChatBodyBudget,
): Promise<{ body: string; model: string }> {
  const { parsed, model } = parseCliBody(bodyStr);
  await applyImageBudget(parsed, { model, ...budget });
  return serializeCliBody(parsed, model);
}

/** Full CodeArts CLI header set for chat requests (see AGENTS.md "Gateway
 * protocol"). `sessionId` maps one gateway session slot. */
export function cliChatHeaders(
  model: string,
  sessionId: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Security-token": "",
    "x-ot-trace-id": uuidHex(),
    "x-ot-span-id": uuidHex(),
    "x-snap-traceid": `${uuidHex()}_${uuidHex().slice(0, 16)}`,
    "x-ot-session-id": sessionId,
    "x-ot-parent-session-id": "",
    "user-session-id": sessionId,
    "x-ot-function": "agent-tui",
    "X-Language": "zh-cn",
    "user-msg-id": `msg_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`,
    "created-time": new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    "x-ot-client-type": "CLI",
    "x-ot-client-version": "26.8.12",
    "client-ip": "198.18.0.1",
    "User-Agent": "ai-sdk/provider-utils/4.0.21 runtime/bun/1.3.14",
  };
  if (model) {
    headers["model-id"] = model;
    headers["model-name"] = model;
  }
  // opengw-discovered models (deepseek-v4, glm-5.3, …) require this header
  // to route past the snap-access gateway's "not registered" check.
  if (model && isOpengwModel(model)) {
    headers["maas_type"] = "benefit";
  }
  return headers;
}

/**
 * Caption prompt for old-turn images. Short and faithful: the description
 * replaces the pixels for all later turns, so it must keep the information a
 * future turn could need without inventing details.
 */
const CAPTION_PROMPT =
  "Describe this image for future reference in one concise paragraph (max 120 words). " +
  "Preserve visible text, UI state, error messages, and details needed to continue the task. " +
  "Do not speculate; reply with the description only.";

const CAPTION_TIMEOUT_MS = 30_000;
const CAPTION_MAX_CHARS = 4000;

/**
 * Creates the old-turn image captioner used by the body budget.
 *
 * The caption request reuses the SAME `user-session-id` as the main chat
 * request: the gateway's 3-concurrent-session limit counts distinct session
 * ids, and minting a new id here would burn one of those slots. Calls are
 * awaited sequentially before the main request is sent, so they never run
 * concurrently with it.
 *
 * Uses a direct signed `fetch` (not the provider fetch wrapper) to avoid
 * recursively entering this hook. Failures return null — the image stays
 * native for that request and is retried on a later one.
 */
function createImageCaptioner(args: {
  ak: string;
  sk: string;
  sessionId: string;
  chatUrl: string;
}): CaptionFn {
  let endpoint = args.chatUrl;
  try {
    endpoint = `${new URL(args.chatUrl).origin}/api/v2/chat/completions`;
  } catch {
    // keep the original URL
  }
  return async (imageUrl, model) => {
    if (!model) return null;
    const body = JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: CAPTION_PROMPT },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      stream: true,
      tool_stream: true,
      user_prompt: CAPTION_PROMPT,
    });
    const headers = mergeHeaders(
      { "Content-Type": "application/json" },
      cliChatHeaders(model, args.sessionId),
    );
    const signed = signRequest(
      "POST",
      endpoint,
      args.ak,
      args.sk,
      headers,
      body,
    );

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: signed,
        body,
        signal: AbortSignal.timeout(CAPTION_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const contentType = res.headers?.get?.("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) return null;

    let raw = "";
    try {
      raw = await res.text();
    } catch {
      return null;
    }
    let out = "";
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let obj: {
        error_code?: unknown;
        choices?: Array<{
          delta?: { content?: unknown };
          message?: { content?: unknown };
        }>;
      };
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      if (typeof obj?.error_code === "string" && obj.error_code) return null;
      const choice = obj?.choices?.[0];
      const delta = choice?.delta?.content ?? choice?.message?.content;
      if (typeof delta === "string") out += delta;
    }
    out = out.trim();
    if (!out) return null;
    return out.length > CAPTION_MAX_CHARS
      ? out.slice(0, CAPTION_MAX_CHARS)
      : out;
  };
}

/**
 * Custom fetch for the OpenAI-compatible SDK (V1 `options.fetch`): signs
 * every request (including streaming chat completions) with the AK/SK.
 *
 * Chat requests additionally get the full CodeArts CLI header set and the
 * CLI's extra body fields (stream, user_prompt, tool_stream): the snap-access
 * gateway routes by request shape — without them the request lands on a
 * wrong backend (Whitelabel 404) or the model reports "not registered".
 */
export function createSignedFetch(
  ak: string,
  sk: string,
  options: {
    sessionId?: string;
    compressImages?: boolean;
    describeImages?: boolean;
  } = {},
) {
  // Callers that must not share a session slot pass an explicit id: the
  // server counts concurrent sessions by user-session-id.
  const sessionId = options.sessionId ?? randomSessionId();
  const compress =
    options.compressImages && sharedImageCompressor
      ? sharedImageCompressor
      : undefined;
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const isChat = isChatCompletionsUrl(url);
    let body =
      init?.body ?? (input instanceof Request ? input.body : undefined);
    let bodyStr =
      typeof body === "string"
        ? body
        : body
          ? await new Response(body).text()
          : "";

    const baseHeaders = collectHeaders(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );

    // Header set to sign and send. For chat requests the CLI header set is
    // merged in case-insensitively (later values win) so an SDK-provided
    // "user-agent" never ends up on the wire twice with different values.
    let outHeaders = baseHeaders;
    if (isChat) {
      const caption =
        options.describeImages && !compress
          ? createImageCaptioner({ ak, sk, sessionId, chatUrl: url })
          : undefined;
      const shaped = await applyCliBodyShapeWithBudget(bodyStr, {
        caption,
        compress,
      });
      bodyStr = shaped.body;
      body = bodyStr;
      outHeaders = mergeHeaders(
        baseHeaders,
        cliChatHeaders(shaped.model, sessionId),
      );
    }

    const signed = signRequest(method, url, ak, sk, outHeaders, bodyStr);
    const res = await fetch(input, { ...init, method, body, headers: signed });
    // Normalize the gateway's pseudo-SSE error wrapping into a real non-2xx
    // JSON error (host retry/backoff policy sees e.g. a true 429). Healthy
    // streams pass through byte-identical.
    if (isChat) return guardChatResponse(res);
    return res;
  };
}

/**
 * Signs a native Request in place of the V1 `options.fetch` injection — the
 * V2 equivalent, meant for the session `http.request` hook. Returns a NEW
 * Request (bodies are one-shot streams); the caller assigns it back to the
 * event. `sessionId` should be the host's real session id so gateway session
 * accounting (3-concurrent limit) follows sessions instead of the process.
 */
export async function signNativeRequest(
  request: Request,
  ak: string,
  sk: string,
  sessionId: string = randomSessionId(),
  options: { compressImages?: boolean; describeImages?: boolean } = {},
): Promise<Request> {
  const compress =
    options.compressImages && sharedImageCompressor
      ? sharedImageCompressor
      : undefined;
  const url = request.url;
  const method = request.method.toUpperCase();

  const baseHeaders = collectHeaders(request);
  // The replacement body differs from the original: a stale content-length
  // would desync the gateway's body hash. Drop it and let the platform
  // recompute for the new body.
  for (const key of Object.keys(baseHeaders)) {
    if (key.toLowerCase() === "content-length") delete baseHeaders[key];
  }
  let bodyStr = "";
  if (method !== "GET" && method !== "HEAD") {
    try {
      bodyStr = await request.text();
    } catch {
      bodyStr = "";
    }
  }

  let outHeaders = baseHeaders;
  let body: string | undefined;
  if (isChatCompletionsUrl(url)) {
    const caption =
      options.describeImages && !compress
        ? createImageCaptioner({ ak, sk, sessionId, chatUrl: url })
        : undefined;
    const shaped = await applyCliBodyShapeWithBudget(bodyStr, {
      caption,
      compress,
    });
    bodyStr = shaped.body;
    body = bodyStr;
    outHeaders = mergeHeaders(
      baseHeaders,
      cliChatHeaders(shaped.model, sessionId),
    );
  }

  const signed = signRequest(method, url, ak, sk, outHeaders, bodyStr);
  return new Request(url, { method, headers: signed, body });
}
