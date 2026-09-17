import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DiscoveredModel } from "./discover.js";

/**
 * File cache for the agent-center model list.
 *
 * Discovery is a two-request network round-trip performed on every `config`
 * and `provider` hook run. The cache lets a transient failure (offline, gateway
 * 5xx) fall back to the last good list instead of dropping to hardcoded models,
 * and serves stale data while the refresh happens in the background.
 *
 * Location: ~/.local/share/opencode/codearts-models.json (same dir as auth.json).
 * Stale files are still used (the model list barely changes); `maxAgeMs` only
 * controls whether a background refresh is attempted, not whether the cache is
 * considered valid.
 */
export type ModelCache = {
  /** Credential-independent key: models differ per account/base, not per AK. */
  base: string;
  fetchedAt: number;
  models: DiscoveredModel[];
};

export function cacheFilePath(): string {
  return join(homedir(), ".local", "share", "opencode", "codearts-models.json");
}

export function readModelCache(
  base: string,
  path: string = cacheFilePath(),
): ModelCache | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as ModelCache;
    if (!raw || !Array.isArray(raw.models)) return null;
    if (raw.base !== base) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeModelCache(
  base: string,
  models: DiscoveredModel[],
  path: string = cacheFilePath(),
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const data: ModelCache = { base, fetchedAt: Date.now(), models };
    writeFileSync(path, JSON.stringify(data), "utf8");
  } catch {
    // cache is best-effort: a read-only home must not break the plugin
  }
}
