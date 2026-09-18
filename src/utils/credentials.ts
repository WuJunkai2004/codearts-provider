import type { PluginOptions } from "@opencode-ai/plugin";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BASE } from "./discover.js";
import { getEnv, PROVIDER_ID } from "./constants.js";

export type StoredAuthEntry = {
  type?: string;
  key?: string;
  metadata?: Record<string, string>;
};

// Reads AK/SK from opencode's /connect credential store
// (~/.local/share/opencode/auth.json, key = SK, metadata.ak = AK).
let storedAuthCache: { ak: string; sk: string } | null | undefined;
export function readStoredAuth(): { ak: string; sk: string } | null {
  if (storedAuthCache !== undefined) return storedAuthCache;
  let result: { ak: string; sk: string } | null = null;
  try {
    const raw = JSON.parse(
      readFileSync(
        join(homedir(), ".local", "share", "opencode", "auth.json"),
        "utf8",
      ),
    ) as Record<string, StoredAuthEntry | undefined>;
    result = parseAuthEntry(raw?.[PROVIDER_ID]);
  } catch {
    // no stored credential
  }
  if (result) storedAuthCache = result;
  return result;
}

// /connect storage shape: key = SK, metadata.ak = AK (two-step flow).
export function parseAuthEntry(
  entry: StoredAuthEntry | undefined,
): { ak: string; sk: string } | null {
  if (entry?.type !== "api" || typeof entry.key !== "string") return null;
  const ak = entry.metadata?.ak;
  const sk = entry.key;
  if (ak && sk) return { ak, sk };
  return null;
}

/** provider options > plugin options > env (no /connect fallback). */
export function resolveDirectCreds(
  opts: { ak?: string; sk?: string } = {},
  pluginOptions: PluginOptions = {},
): { ak: string; sk: string } | null {
  const po = pluginOptions as { ak?: string; sk?: string };
  const ak = opts.ak ?? po.ak ?? getEnv("CODEARTS_CLI_AK");
  const sk = opts.sk ?? po.sk ?? getEnv("CODEARTS_CLI_SK");
  if (ak && sk) return { ak, sk };
  return null;
}

/** provider options > plugin options > env > /connect stored auth. */
export function resolveCreds(
  opts: { ak?: string; sk?: string } = {},
  pluginOptions: PluginOptions = {},
): { ak: string; sk: string } | null {
  return resolveDirectCreds(opts, pluginOptions) ?? readStoredAuth();
}

/** Strips a trailing `/api/v2`, so `baseURL` may be passed with or without it. */
export function resolveBase(
  opts: { baseURL?: string } = {},
  pluginOptions: PluginOptions = {},
): string {
  const po = pluginOptions as { baseURL?: string };
  const raw = opts.baseURL ?? po.baseURL ?? DEFAULT_BASE;
  return String(raw)
    .replace(/\/api\/v2\/?$/, "")
    .replace(/\/$/, "");
}
