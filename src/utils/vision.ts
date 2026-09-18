import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { createSignedFetch } from "./signer.js";

/**
 * Minimal chat call against the CodeArts InferHub gateway, used by the vision
 * tool to turn an image into text with a fixed multimodal model.
 *
 * Uses its own createSignedFetch instance (and thus its own user-session-id):
 * the server counts concurrent sessions per user-session-id (limit 3), so the
 * vision sub-call must not share the main chat's slot.
 */
export type VisionRequest = {
  ak: string;
  sk: string;
  base: string;
  model: string;
  image: { dataUrl: string };
  prompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export function imageToDataUrl(filePath: string): string {
  const mime = MIME_BY_EXT[extname(filePath).toLowerCase()] ?? "image/png";
  const b64 = readFileSync(filePath).toString("base64");
  return `data:${mime};base64,${b64}`;
}

type ChatChunk = {
  choices?: Array<{ delta?: { content?: string } }>;
};

/** Extracts assistant text from an OpenAI-compatible response (SSE or JSON). */
export function extractContent(
  raw: string,
  contentType: string | null,
): string {
  const looksSSE =
    (contentType ?? "").includes("event-stream") || raw.startsWith("data:");
  if (!looksSSE) {
    try {
      const json = JSON.parse(raw) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return json.choices?.[0]?.message?.content ?? "";
    } catch {
      return "";
    }
  }
  const parts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const chunk = JSON.parse(data) as ChatChunk;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) parts.push(delta);
    } catch {
      // ignore malformed keepalive/partial lines
    }
  }
  return parts.join("");
}

export async function describeImage(req: VisionRequest): Promise<string> {
  const { ak, sk, base, model, image, prompt } = req;
  const doFetch = req.fetchImpl ?? createSignedFetch(ak, sk);
  const url = `${base.replace(/\/$/, "")}/api/v2/chat/completions`;
  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: image.dataUrl } },
        ],
      },
    ],
    stream: true,
    tool_stream: true,
    user_prompt: prompt,
    ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
  };

  const res = await doFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `vision request failed: HTTP ${res.status} ${detail.slice(0, 400)}`,
    );
  }
  const raw = await res.text();
  return extractContent(raw, res.headers?.get?.("content-type") ?? null).trim();
}
