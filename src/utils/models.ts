import type { Config, PluginOptions } from "@opencode-ai/plugin";
import type { Model } from "@opencode-ai/sdk/v2";
import { readModelCache, writeModelCache } from "./cache.js";
import { discoverModels, type DiscoveredModel } from "./discover.js";
import { detectLangZH, getTranslations } from "./i18n.js";
import { HINT_MODEL_ID, PROVIDER_ID } from "./constants.js";
import { resolveBase, resolveCreds } from "./credentials.js";
import { syncOpengwModels } from "./opengw.js";

// Cache of the last successful discovery, kept as a module-level fallback for
// the brief window before the file cache is read (and for tests).
let lastGoodModels: DiscoveredModel[] | null = null;

export async function fetchModels(
  opts: Record<string, unknown>,
  pluginOptions: PluginOptions,
) {
  const base = resolveBase(opts as { baseURL?: string }, pluginOptions);
  const creds = resolveCreds(
    opts as { ak?: string; sk?: string },
    pluginOptions,
  );
  if (!creds) {
    syncOpengwModels(null);
    return { base, models: null as DiscoveredModel[] | null, creds: null };
  }
  try {
    const discovered = await discoverModels(creds.ak, creds.sk, base);
    if (discovered.length > 0) {
      lastGoodModels = discovered;
      writeModelCache(base, discovered);
      syncOpengwModels(discovered);
      return { base, models: discovered, creds };
    }
  } catch (e) {
    console.error(
      "[codearts-provider] model discovery failed, falling back to cache:",
      (e as Error)?.message ?? e,
    );
  }
  // Discovery failed or returned nothing: reuse the last good list (in-memory,
  // then on disk) instead of hardcoded models. Returning null keeps the
  // "no models" path so the caller can show the connect hint.
  const cached =
    (lastGoodModels && lastGoodModels.length > 0 ? lastGoodModels : null) ??
    readModelCache(base)?.models ??
    null;
  syncOpengwModels(cached);
  return { base, models: cached, creds };
}

export function toModel(m: DiscoveredModel, base: string): Model {
  return {
    id: m.id,
    providerID: PROVIDER_ID,
    name: m.name ?? m.id,
    family: "codearts",
    api: {
      id: m.id,
      url: `${base}/api/v2`,
      npm: "@ai-sdk/openai-compatible",
    },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 131072, output: m.output ?? 32768 },
    capabilities: {
      temperature: true,
      reasoning: Boolean(m.reasoning),
      attachment: Boolean(m.images),
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: Boolean(m.images),
        video: false,
        pdf: false,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  };
}

export type ConfigModel = NonNullable<
  NonNullable<Config["provider"]>[string]["models"]
>[string];

/**
 * V2 `Model.Info` shape (docs/build/plugins — ProviderEditor.add({ models })).
 * The V1 `toModel()` shape (api/capabilities objects) does not validate in a
 * real V2 host: capabilities carry input/output modality ARRAYS here, `modelID`
 * is required, cost is an array of tiers, and `enabled`/`time` are mandatory.
 */
export function toModelInfo(m: DiscoveredModel): Record<string, unknown> {
  return {
    id: m.id,
    modelID: m.id,
    providerID: PROVIDER_ID,
    name: m.name ?? m.id,
    capabilities: {
      tools: true,
      input: m.images ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    variants: [],
    time: { released: 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: m.context ?? 131072, output: m.output ?? 32768 },
  };
}

/** Placeholder model for the "not connected" state: its displayed name tells
 * the user to run /connect. Same V2 shape as real models. */
export function hintModelInfo(): Record<string, unknown> {
  return {
    id: HINT_MODEL_ID,
    modelID: HINT_MODEL_ID,
    providerID: PROVIDER_ID,
    name: getTranslations(detectLangZH()).hintModelName,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: 131072, output: 32768 },
  };
}

export function toConfigModel(m: DiscoveredModel): ConfigModel {
  const cfg: Record<string, unknown> = {
    name: m.name ?? m.id,
    limit: { context: m.context ?? 131072, output: m.output ?? 32768 },
    tool_call: true,
  };
  if (m.reasoning) cfg.reasoning = true;
  if (m.images) cfg.attachment = true;
  return cfg as ConfigModel;
}

export function hintConfigModel(): ConfigModel {
  return {
    name: getTranslations(detectLangZH()).hintModelName,
    limit: { context: 1, output: 1 },
  } as ConfigModel;
}
