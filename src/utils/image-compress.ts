/**
 * Optional outgoing-image compression (plugin option `compressImages`).
 *
 * Re-encodes inline images to WebP at their NATIVE resolution. In compression
 * mode this applies to EVERY image — including the current turn — so an image
 * is always sent as the same WebP from its first appearance (stable prompt-
 * cache prefix). The resolution is deliberately not reduced: computer-use
 * agents derive click coordinates from the pixels they see, and WebP q80 at
 * native resolution is effectively lossless for this purpose.
 *
 * Uses Bun's built-in `Bun.Image` (opencode 1.3.14+). When the runtime lacks
 * it (Node tests, older hosts) `createImageCompressor` returns null and
 * `compressImages` has no effect (the `describeImages` path, if enabled, still
 * works).
 *
 * The compressor caches by image content hash in memory. Re-compressing the
 * same image after a process restart produces the same bytes, so the prompt
 * cache prefix stays stable.
 */

import { createHash } from "node:crypto";

export type ImageCompressFn = (imageUrl: string) => Promise<string | null>;

export type ImageCompressor = {
  /** Returns a compressed data URL, or null when compression fails or does
   * not reduce the payload. Cached per image hash, so repeated calls for the
   * same image do not re-encode. */
  compress: ImageCompressFn;
};

const WEBP_QUALITY = 80;
const MAX_CACHE_ENTRIES = 128;
const MIN_SAVING_RATIO = 0.95;
const COMPRESSIBLE_IMAGE_URL = /^data:image\/(?:png|jpe?g|webp|gif|bmp);/i;

type BunImageLike = {
  webp(options: { quality: number }): {
    toBuffer(): Promise<Uint8Array | ArrayBuffer>;
  };
};

type BunLike = {
  image?: (input: unknown) => BunImageLike;
  Image?: new (input: unknown) => BunImageLike;
};

function bunImageFactory(): ((input: unknown) => BunImageLike) | null {
  const bun = (globalThis as { Bun?: BunLike }).Bun;
  if (typeof bun?.image === "function") return (input) => bun.image!(input);
  if (typeof bun?.Image === "function") {
    const Ctor = bun.Image;
    return (input) => new Ctor(input);
  }
  return null;
}

export function createImageCompressor(options: {
  quality?: number;
  maxEntries?: number;
} = {}): ImageCompressor | null {
  const factory = bunImageFactory();
  if (!factory) return null;
  const quality = options.quality ?? WEBP_QUALITY;
  const maxEntries = options.maxEntries ?? MAX_CACHE_ENTRIES;
  const cache = new Map<string, string | null>();
  const keyOf = (url: string): string =>
    createHash("sha256").update(url).digest("hex");

  const remember = (key: string, value: string | null): void => {
    cache.set(key, value);
    if (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  };

  return {
    async compress(imageUrl) {
      const key = keyOf(imageUrl);
      if (cache.has(key)) return cache.get(key) ?? null;
      if (!COMPRESSIBLE_IMAGE_URL.test(imageUrl)) {
        remember(key, null);
        return null;
      }

      let result: string | null = null;
      try {
        const comma = imageUrl.indexOf(",");
        const base64 = comma >= 0 ? imageUrl.slice(comma + 1) : "";
        const originalBytes = Math.floor((base64.length * 3) / 4);
        const raw = await factory(imageUrl).webp({ quality }).toBuffer();
        const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        if (bytes.length > 0 && bytes.length < originalBytes * MIN_SAVING_RATIO) {
          result = `data:image/webp;base64,${Buffer.from(bytes).toString("base64")}`;
        }
      } catch {
        result = null;
      }
      remember(key, result);
      return result;
    },
  };
}