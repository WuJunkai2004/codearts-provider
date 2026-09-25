import { createHmac, createHash } from "node:crypto";
import { isOpengwModel } from "./opengw.js";

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
 * header must never reach the gateway — see README "APIG.0301"). */
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
 * `user_prompt`. Returns the shaped JSON and the routing model id. */
export function applyCliBodyShape(bodyStr: string): {
  body: string;
  model: string;
} {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = bodyStr ? JSON.parse(bodyStr) : {};
  } catch {
    parsed = {};
  }
  const model = typeof parsed.model === "string" ? parsed.model : "";
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
  parsed.user_prompt =
    typeof parsed.user_prompt === "string"
      ? parsed.user_prompt
      : typeof lastText === "string"
        ? lastText
        : "";
  return { body: JSON.stringify(parsed), model };
}

/** Full CodeArts CLI header set for chat requests (see README "gateway
 * routing" section). `sessionId` maps one gateway session slot. */
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
  options: { sessionId?: string } = {},
) {
  // Callers that must not share a session slot (e.g. the vision tool) pass an
  // explicit id: the server counts concurrent sessions by user-session-id.
  const sessionId = options.sessionId ?? randomSessionId();
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
      const shaped = applyCliBodyShape(bodyStr);
      bodyStr = shaped.body;
      body = bodyStr;
      outHeaders = mergeHeaders(
        baseHeaders,
        cliChatHeaders(shaped.model, sessionId),
      );
    }

    const signed = signRequest(method, url, ak, sk, outHeaders, bodyStr);
    return fetch(input, { ...init, method, body, headers: signed });
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
): Promise<Request> {
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
    const shaped = applyCliBodyShape(bodyStr);
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
