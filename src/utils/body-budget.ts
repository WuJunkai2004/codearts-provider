/**
 * Chat request body size guard for the Huawei APIG gateway.
 *
 * APIG rejects forwarded bodies over ~12 MB with a generic
 * `InferHub.001001005.400` (no size hint). The usual culprit is replayed
 * multimodal history: every pasted image / tool screenshot is a base64
 * `image_url` data URL that is sent again on every turn.
 *
 * Policy:
 *   1. Default: DO NOTHING. Images are sent exactly as the host built them;
 *      a cached caption/compression is not replayed unless the corresponding
 *      option is on. If the body still exceeds the gateway cap, the gateway
 *      reports its own error.
 *   2. `describeImages` (default FALSE): over MAX_CHAT_BODY_BYTES, replace
 *      EVERY image from old turns (everything before the last real `user`
 *      message) with a stable text caption. Newest old images first.
 *   3. `compressImages` (default FALSE): on every request, re-encode EVERY
 *      inline image — including the current turn — to a smaller WebP at
 *      NATIVE resolution (compressor cache = one encode per image). No
 *      turn-boundary distinction: an image is always the same WebP from the
 *      first request, keeping the prompt-cache prefix stable. This REPLACES
 *      captioning (compress takes precedence) — no caption model calls, no
 *      request slowdown.
 *   4. `describeImages` captioning / the default no-op leave the CURRENT
 *      turn's images native. There is no placeholder/discard fallback and no
 *      local hard cap: dropping pixels loses information.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ImageCompressor } from "./image-compress.js";

/** Soft watermark: leave ~2 MB under the 12 MB APIG body cap. */
export const MAX_CHAT_BODY_BYTES = 10 * 1024 * 1024;

/** Stop calling the caption model after this many consecutive failures; the
 * images stay native for this request and are retried next time. */
const MAX_CAPTION_FAILURES = 2;

type Part = Record<string, unknown> & {
  type?: string;
  image_url?: unknown;
  image?: unknown;
  file?: { file_data?: unknown };
};

export type ImageRef = {
  holder: unknown[];
  index: number;
  msgIndex: number;
  /** Current inline `data:image/...` URL (compressed when applicable). */
  url: string;
  /** Original URL; caption/cache keys stay stable even after compression. */
  originalUrl: string;
};

/** Extracts the inline image data URL of a content part. */
function imageUrlOf(part: unknown): string | null {
  if (!part || typeof part !== "object" || Array.isArray(part)) return null;
  const p = part as Part;
  if (p.type === "image_url" || p.type === "input_image") {
    const value = p.image_url;
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const url = (value as { url?: unknown }).url;
      if (typeof url === "string") return url;
    }
    return null;
  }
  if (p.type === "image" && typeof p.image === "string") return p.image;
  if (
    p.type === "file" &&
    typeof p.file?.file_data === "string" &&
    p.file.file_data.startsWith("data:image/")
  ) {
    return p.file.file_data;
  }
  return null;
}

const isInlineImageUrl = (url: string): boolean => url.startsWith("data:image/");

/** Walks the OpenAI `messages[].content` arrays. Tool schemas and other fields
 * stay untouched. */
export function collectImageRefs(messages: unknown): ImageRef[] {
  const refs: ImageRef[] = [];
  if (!Array.isArray(messages)) return refs;
  for (let m = 0; m < messages.length; m++) {
    const content = (messages[m] as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (let i = 0; i < content.length; i++) {
      const url = imageUrlOf(content[i]);
      if (!url || !isInlineImageUrl(url)) continue;
      refs.push({
        holder: content,
        index: i,
        msgIndex: m,
        url,
        originalUrl: url,
      });
    }
  }
  return refs;
}

function lastUserMessageIndex(messages: unknown): number {
  if (!Array.isArray(messages)) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: unknown })?.role === "user") return i;
  }
  return -1;
}

export type CaptionStore = {
  get(id: string): string | undefined;
  set(id: string, caption: string): void;
  /** Number of cached captions (loads the backing file on first call). */
  size(): number;
  flush(): void;
};

const MAX_CAPTION_ENTRIES = 5000;

export function captionCachePath(): string {
  return join(
    homedir(),
    ".local",
    "share",
    "opencode",
    "codearts-image-captions.json",
  );
}

/** Best-effort persistent caption store keyed by sha256(image data URL). */
export function createCaptionStore(
  path: string = captionCachePath(),
): CaptionStore {
  let loaded = false;
  let dirty = false;
  const captions = new Map<string, string>();

  const load = (): void => {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        captions?: Record<string, unknown>;
      };
      const entries = Object.entries(raw?.captions ?? {});
      // Keep insertion order; trim oldest if a legacy file is oversized.
      for (const [id, text] of entries.slice(-MAX_CAPTION_ENTRIES)) {
        if (typeof text === "string") captions.set(id, text);
      }
    } catch {
      // missing/malformed cache is a miss
    }
  };

  return {
    get(id) {
      load();
      return captions.get(id);
    },
    set(id, caption) {
      load();
      captions.set(id, caption);
      if (captions.size > MAX_CAPTION_ENTRIES) {
        const oldest = captions.keys().next().value;
        if (oldest !== undefined) captions.delete(oldest);
      }
      dirty = true;
    },
    size() {
      load();
      return captions.size;
    },
    flush() {
      if (!dirty) return;
      dirty = false;
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          JSON.stringify({ v: 1, captions: Object.fromEntries(captions) }),
          "utf8",
        );
      } catch {
        // cache is best-effort: a read-only home must not break the request
      }
    },
  };
}

const defaultStore = createCaptionStore();

export const imageId = (url: string): string =>
  createHash("sha256").update(url).digest("hex");

export type CaptionFn = (
  imageUrl: string,
  model: string,
) => Promise<string | null>;

export type ImageBudgetOptions = {
  /** Routing alias used for the caption request (the current chat model). */
  model?: string;
  /** Caption generator; absent = skip the caption stage (sync/tests). */
  caption?: CaptionFn;
  /** Optional compression fast path (plugin option `compressImages`). When
   * present it REPLACES captioning: no caption model calls are made. */
  compress?: ImageCompressor;
  store?: CaptionStore;
  maxBytes?: number;
};

/** Raster data URLs the caption models accept; anything else is left alone. */
const CAPTIONABLE_IMAGE_URL = /^data:image\/(?:png|jpe?g|webp|gif|bmp);/i;

/**
 * Cache-aware budget pass.
 *
 * Nothing happens unless at least one strategy is configured:
 *   - neither `compress` nor `caption` (default): byte-identical request;
 *   - `compress` present (`compressImages` option): EVERY inline image —
 *     including the current turn — is WebP-compressed (cached per hash); NO
 *     caption-model calls are made. Compression wins over `caption` when both
 *     are supplied;
 *   - only `caption` present (`describeImages` option): when the body exceeds
 *     `maxBytes`, caption EVERY old-turn image, newest first. Cached captions
 *     are replayed even under budget. The current turn stays native.
 *
 * The current turn's images always stay native. There is no
 * placeholder/discard fallback and no local hard error. Only the outgoing
 * request is rewritten; the host's stored history is untouched.
 */
export async function applyImageBudget(
  parsed: Record<string, unknown>,
  opts: ImageBudgetOptions = {},
): Promise<{ captioned: number; compressed: number }> {
  const maxBytes = opts.maxBytes ?? MAX_CHAT_BODY_BYTES;

  // Default: do nothing. Captioning requires `describeImages`, compression
  // requires `compressImages`; neither option means the request is untouched.
  if (!opts.compress && !opts.caption) {
    return { captioned: 0, compressed: 0 };
  }

  const refs = collectImageRefs(parsed.messages);
  if (refs.length === 0) return { captioned: 0, compressed: 0 };

  // Everything before the last real user message is a previous turn.
  const currentStart = lastUserMessageIndex(parsed.messages);
  const oldRefs =
    currentStart <= 0 ? [] : refs.filter((r) => r.msgIndex < currentStart);

  // `compressImages` fast path: re-encode EVERY inline image — including the
  // current turn — and STOP. No turn-boundary distinction: from the moment an
  // image enters the conversation it is always sent as the same WebP, which
  // keeps the prompt-cache prefix stable. Compression replaces captioning
  // entirely, so no caption model is called (no request slowdown). The
  // compressor caches per image hash, so each image is encoded only once.
  if (opts.compress) {
    let compressed = 0;
    for (const ref of refs) {
      const out = await opts.compress.compress(ref.originalUrl);
      if (!out) continue;
      ref.holder[ref.index] = {
        type: "image_url",
        image_url: { url: out },
      };
      ref.url = out;
      compressed++;
    }
    return { captioned: 0, compressed };
  }

  // Default caption strategy (`describeImages`): old turns only.
  // Newest old image first: the first modified byte stays as close to the
  // conversation tail as possible, preserving the cached prefix.
  oldRefs.reverse();

  const store = opts.store ?? defaultStore;
  const applied = new Set<ImageRef>();
  let captioned = 0;
  const applyCaption = (ref: ImageRef, text: string): void => {
    ref.holder[ref.index] = { type: "text", text };
    applied.add(ref);
    captioned++;
  };

  // Replay every cached caption unconditionally — even under budget — so a
  // previously captioned image never reverts to pixels on a later turn.
  if (oldRefs.length > 0 && store.size() > 0) {
    for (const ref of oldRefs) {
      const text = store.get(imageId(ref.originalUrl));
      if (text) applyCaption(ref, text);
    }
  }

  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") <= maxBytes) {
    return { captioned, compressed: 0 };
  }

  const caption = opts.caption;
  if (!caption) return { captioned, compressed: 0 };

  let failures = 0;
  for (const ref of oldRefs) {
    if (applied.has(ref)) continue;
    if (failures >= MAX_CAPTION_FAILURES) continue;
    if (!CAPTIONABLE_IMAGE_URL.test(ref.url)) continue;

    const id = imageId(ref.originalUrl);
    let text = store.get(id);
    if (text === undefined) {
      failures++;
      try {
        text = (await caption(ref.url, opts.model ?? "")) ?? undefined;
      } catch {
        text = undefined;
      }
      if (!text) continue;
      failures = 0;
      store.set(id, text);
    }
    if (!text) continue;
    applyCaption(ref, text);
  }
  store.flush();

  return { captioned, compressed: 0 };
}