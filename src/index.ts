import {
  tool,
  type Plugin,
  type PluginModule,
  type Hooks,
  type Config,
  type ProviderHook,
  type AuthHook,
  type PluginOptions,
} from "@opencode-ai/plugin";
import type { Model, Provider, Auth } from "@opencode-ai/sdk/v2";
import { z } from "zod";
import { createSignedFetch } from "./signer.js";
import { describeImage, imageToDataUrl } from "./vision.js";
import { readModelCache, writeModelCache } from "./cache.js";
import {
  discoverModels,
  DEFAULT_BASE,
  type DiscoveredModel,
} from "./discover.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { detectLangZH, getTranslations } from "./i18n.js";

const PROVIDER_ID = "codearts";

const getEnv = (name: string): string | undefined => process.env[name];

// Resolves a user-supplied image path against the session's project directory.
function resolvePath(directory: string, p: string): string {
  return isAbsolute(p) ? p : join(directory || process.cwd(), p);
}

// Reads AK/SK from opencode's /connect credential store
// (~/.local/share/opencode/auth.json, key = SK, metadata.ak = AK).
let storedAuthCache: { ak: string; sk: string } | null | undefined;
function readStoredAuth(): { ak: string; sk: string } | null {
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

function resolveCreds(
  opts: { ak?: string; sk?: string } = {},
  pluginOptions: PluginOptions = {},
): { ak: string; sk: string } | null {
  const po = pluginOptions as { ak?: string; sk?: string };
  const ak = opts.ak ?? po.ak ?? getEnv("CODEARTS_CLI_AK");
  const sk = opts.sk ?? po.sk ?? getEnv("CODEARTS_CLI_SK");
  if (ak && sk) return { ak, sk };
  return readStoredAuth();
}

function resolveBase(
  opts: { baseURL?: string } = {},
  pluginOptions: PluginOptions = {},
): string {
  const po = pluginOptions as { baseURL?: string };
  const raw = opts.baseURL ?? po.baseURL ?? DEFAULT_BASE;
  return String(raw)
    .replace(/\/api\/v2\/?$/, "")
    .replace(/\/$/, "");
}

// Placeholder model injected when no credentials exist yet. It never routes to
// the gateway — its name carries the connect hint instead.
const HINT_MODEL_ID = "connect-required";

// Cache of the last successful discovery, kept as a module-level fallback for
// the brief window before the file cache is read (and for tests).
let lastGoodModels: DiscoveredModel[] | null = null;

type StoredAuthEntry = {
  type?: string;
  key?: string;
  metadata?: Record<string, string>;
};

// /connect storage shape: key = SK, metadata.ak = AK (two-step flow).
function parseAuthEntry(
  entry: StoredAuthEntry | undefined,
): { ak: string; sk: string } | null {
  if (entry?.type !== "api" || typeof entry.key !== "string") return null;
  const ak = entry.metadata?.ak;
  const sk = entry.key;
  if (ak && sk) return { ak, sk };
  return null;
}

function toModel(m: DiscoveredModel, base: string): Model {
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

type ConfigModel = NonNullable<
  NonNullable<Config["provider"]>[string]["models"]
>[string];

function toConfigModel(m: DiscoveredModel): ConfigModel {
  const cfg: Record<string, unknown> = {
    name: m.name ?? m.id,
    limit: { context: m.context ?? 131072, output: m.output ?? 32768 },
    tool_call: true,
  };
  if (m.reasoning) cfg.reasoning = true;
  if (m.images) cfg.attachment = true;
  return cfg as ConfigModel;
}

async function fetchModels(
  opts: Record<string, unknown>,
  pluginOptions: PluginOptions,
) {
  const base = resolveBase(opts as { baseURL?: string }, pluginOptions);
  const creds = resolveCreds(
    opts as { ak?: string; sk?: string },
    pluginOptions,
  );
  if (!creds)
    return { base, models: null as DiscoveredModel[] | null, creds: null };
  try {
    const discovered = await discoverModels(creds.ak, creds.sk, base);
    if (discovered.length > 0) {
      lastGoodModels = discovered;
      writeModelCache(base, discovered);
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
  return { base, models: cached, creds };
}

// Name of the tool exposed to the LLM when the vision tool is enabled.
export const VISION_TOOL_ID = "codearts_vision";
// Default multimodal model used by the vision tool (routing alias).
export const DEFAULT_VISION_MODEL = "Qwen3-VL-235B";

const server: Plugin = async (_input, pluginOptions = {}) => {
  const po = pluginOptions as {
    visionTool?: boolean;
    visionModel?: string;
  };
  const visionEnabled = po.visionTool !== false;
  const visionModel = po.visionModel ?? DEFAULT_VISION_MODEL;
  const t = getTranslations(detectLangZH());

  // The vision tool is a plugin-level LLM tool, registered whenever the option
  // is on. Credentials are resolved lazily at call time: the config hook may
  // not see /connect-stored credentials on first boot, so a registration-time
  // guard would silently drop the tool. Calling without credentials yields a
  // clear error instead.
  const visionTool = tool({
    description: t.visionToolDescription,
    args: {
      image: z
        .string()
        .optional()
        .describe("Local image file path (png/jpg/jpeg/gif/webp/bmp)"),
      image_url: z
        .string()
        .optional()
        .describe("Remote image URL or data: URL"),
      prompt: z
        .string()
        .optional()
        .describe("What to ask about the image (default: describe it)"),
    },
    execute: async (args, context) => {
      const creds = resolveCreds({}, pluginOptions);
      if (!creds) throw new Error(t.visionNoCreds);

      let dataUrl: string;
      if (args.image) {
        dataUrl = imageToDataUrl(resolvePath(context.directory, args.image));
      } else if (args.image_url) {
        dataUrl = args.image_url;
      } else {
        throw new Error(t.visionNoImage);
      }
      const out = await describeImage({
        ak: creds.ak,
        sk: creds.sk,
        base: resolveBase({}, pluginOptions),
        model: visionModel,
        image: { dataUrl },
        prompt: args.prompt ?? t.visionDefaultPrompt,
        signal: context.abort,
      });
      if (!out) throw new Error(t.visionEmpty);
      return {
        title: `${t.visionTitle} · ${visionModel}`,
        output: out,
        metadata: {
          model: visionModel,
          image: args.image ?? args.image_url,
        },
      };
    },
  });

  const hooks: Hooks = {
    // Runs before opencode reads cfg.provider. The provider is ALWAYS
    // registered (so it shows up in /connect even without credentials);
    // the signed fetch is only injected when credentials exist.
    config: async (config: Config) => {
      config.provider = config.provider ?? {};
      const { base, models, creds } = await fetchModels({}, pluginOptions);

      const existing = config.provider[PROVIDER_ID];
      const target = (existing ?? {}) as {
        name?: string;
        npm?: string;
        options?: { baseURL?: string; apiKey?: string; fetch?: unknown };
        models?: Record<string, ConfigModel>;
      };
      target.name = target.name ?? "Huawei CodeArts";
      target.npm = target.npm ?? "@ai-sdk/openai-compatible";
      target.options = target.options ?? {};
      target.options.baseURL = target.options.baseURL ?? `${base}/api/v2`;
      if (creds && !target.options.fetch) {
        // placeholder apiKey: the OpenAI-compatible SDK insists on one, but the
        // signed Authorization header produced by options.fetch wins on the wire
        target.options.apiKey = target.options.apiKey ?? "codearts-signed";
        target.options.fetch = createSignedFetch(creds.ak, creds.sk);
        if (
          models &&
          models.length > 0 &&
          (!existing || Object.keys(target.models ?? {}).length === 0)
        ) {
          const modelEntries: Record<string, ConfigModel> = {};
          for (const m of models) modelEntries[m.id] = toConfigModel(m);
          target.models = modelEntries;
        }
      } else if (!creds) {
        // No credentials: register a single hint model instead of the fallback
        // list. Its displayed name tells the user to run /connect.
        target.models = {
          [HINT_MODEL_ID]: {
            name: getTranslations(detectLangZH()).hintModelName,
            limit: { context: 1, output: 1 },
          } as ConfigModel,
        };
      }
      config.provider[PROVIDER_ID] = target as (typeof config.provider)[string];
    },

    // Dynamic model refresh for sessions where the provider is already in the
    // database (e.g. listed in models.dev).
    provider: {
      id: PROVIDER_ID,
      models: async (provider: Provider) => {
        const opts = (provider?.options ?? {}) as Record<string, unknown>;
        const { base, models } = await fetchModels(opts, pluginOptions);
        const out: Record<string, Model> = {};
        if (!models) {
          out[HINT_MODEL_ID] = toModel(
            {
              id: HINT_MODEL_ID,
              name: getTranslations(detectLangZH()).hintModelName,
            },
            base,
          );
          return out;
        }
        for (const m of models) out[m.id] = toModel(m, base);
        return out;
      },
    } satisfies ProviderHook,

    // Turns a stored /connect credential into provider options: placeholder
    // apiKey plus the signed fetch injected via options.fetch.
    //
    // Two-step /connect flow (api type): our custom prompt collects the AK
    // first (stored as metadata.ak), then the TUI's built-in "API key" page
    // collects the SK (stored as auth.key). The label doubles as the final
    // page title, so it spells out "SK, step 2/2".
    auth: (() => {
      const t = getTranslations(detectLangZH());
      return {
        provider: PROVIDER_ID,
        loader: async (getAuth: () => Promise<Auth | undefined>) => {
          const auth = await getAuth();
          const opts: Record<string, unknown> = {};
          const creds = parseAuthEntry(auth as StoredAuthEntry);
          if (!creds) return opts;
          opts.apiKey = "codearts-signed";
          opts.fetch = createSignedFetch(creds.ak, creds.sk);
          return opts;
        },
        methods: [
          {
            type: "api",
            label: t.skTitle,
            prompts: [
              {
                type: "text",
                key: "ak",
                message: t.akPrompt,
                placeholder: t.akPlaceholder,
              },
            ],
          },
        ],
      } satisfies AuthHook;
    })(),
    tool: visionEnabled ? { [VISION_TOOL_ID]: visionTool } : undefined,
  };
  return hooks;
};

const mod: PluginModule = {
  id: "opencode-codearts-provider",
  server,
};

export default mod;
