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

/**
 * Custom fetch for the OpenAI-compatible SDK: signs every request
 * (including streaming chat completions) with the AK/SK.
 */
export function createSignedFetch(ak: string, sk: string) {
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
    const body =
      init?.body ?? (input instanceof Request ? input.body : undefined);
    const bodyStr =
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

    const signed = signRequest(method, url, ak, sk, baseHeaders, bodyStr);
    return fetch(input, { ...init, headers: signed });
  };
}
