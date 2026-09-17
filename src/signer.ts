import { createHmac, createHash } from "node:crypto";

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

/**
 * Custom fetch for the OpenAI-compatible SDK: signs every request
 * (including streaming chat completions) with the AK/SK.
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
  // per-process pseudo session id, mirrors one TUI chat session. Callers that
  // must not share a session slot (e.g. the vision tool) pass an explicit id:
  // the server counts concurrent sessions by user-session-id (limit 3).
  const sessionId =
    options.sessionId ??
    `ses_${Math.random().toString(36).slice(2, 11)}${Date.now().toString(36)}`;
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
    const isChat = CHAT_PATH_RE.test(url);
    let body =
      init?.body ?? (input instanceof Request ? input.body : undefined);
    let bodyStr =
      typeof body === "string"
        ? body
        : body
          ? await new Response(body).text()
          : "";

    const baseHeaders: Record<string, string> = {};
    const srcHeaders =
      init?.headers ?? (input instanceof Request ? input.headers : undefined);
    if (srcHeaders) {
      const iter =
        srcHeaders instanceof Headers
          ? srcHeaders.entries()
          : Array.isArray(srcHeaders)
            ? (srcHeaders as [string, string][])
            : Object.entries(srcHeaders as Record<string, string>);
      for (const [k, v] of iter) {
        if (k.toLowerCase() === "authorization") continue;
        baseHeaders[k] = v;
      }
    }

    // Header set to sign and send. For chat requests the CLI header set is
    // merged in case-insensitively (later values win) so an SDK-provided
    // "user-agent" never ends up on the wire twice with different values.
    let outHeaders = baseHeaders;
    if (isChat) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = bodyStr ? JSON.parse(bodyStr) : {};
      } catch {
        parsed = {};
      }
      const model = typeof parsed.model === "string" ? parsed.model : "";
      // CLI body shape: streaming + tool_stream + last user turn echoed
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
      bodyStr = JSON.stringify(parsed);
      body = bodyStr;

      // full CLI header set (see README "gateway routing" section)
      const cliHeaders: Record<string, string> = {
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
        cliHeaders["model-id"] = model;
        cliHeaders["model-name"] = model;
      }
      // merge case-insensitively: SDK may pass "user-agent" while the CLI
      // headers use "User-Agent" — both would go on the wire but only one is
      // signed, breaking the signature. Later values win.
      const merged: Record<string, string> = {};
      const lowerToKey = new Map<string, string>();
      for (const [k, v] of Object.entries(baseHeaders)) {
        const lower = k.toLowerCase();
        const existing = lowerToKey.get(lower);
        if (existing !== undefined) delete merged[existing];
        merged[k] = v;
        lowerToKey.set(lower, k);
      }
      for (const [k, v] of Object.entries(cliHeaders)) {
        const lower = k.toLowerCase();
        const existing = lowerToKey.get(lower);
        if (existing !== undefined) delete merged[existing];
        merged[k] = v;
        lowerToKey.set(lower, k);
      }
      outHeaders = merged;
    }

    const signed = signRequest(method, url, ak, sk, outHeaders, bodyStr);
    return fetch(input, { ...init, method, body, headers: signed });
  };
}
