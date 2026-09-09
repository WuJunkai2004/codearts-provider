import type {
  Plugin,
  PluginModule,
  Hooks,
  Config,
  ProviderHook,
  AuthHook,
  PluginOptions,
} from "@opencode-ai/plugin";
import type { Model, Provider, Auth } from "@opencode-ai/sdk/v2";
import { createSignedFetch } from "./signer.js";
import {
  discoverModels,
  DEFAULT_BASE,
  type DiscoveredModel,
} from "./discover.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectLangZH, getTranslations } from "./i18n.js";

const PROVIDER_ID = "codearts";

const getEnv = (name: string): string | undefined => process.env[name];

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

// Models reachable through the gateway but NOT served by agent-center
// discovery for this account (verified live; ids are routing aliases).
// Qwen3.6-27B-VL / Qwen3.5-397B-A17B-VL / ClaudeV1 / Qwen3-Coder-30B-A3B
// are NOT registered for this account and were removed.
const EXTRA_MODELS: DiscoveredModel[] = [
  {
    id: "GLM-5.2",
    name: "GLM-5.2",
    context: 202752,
    output: 131072,
    reasoning: true,
    images: false,
  },
  {
    id: "glm-5.2-sft-harmony",
    name: "GLM-5.2-ArkTS-SPARK",
    context: 131072,
    output: 32768,
    reasoning: true,
    images: false,
  },
  {
    id: "Qwen3-VL-235B",
    name: "Qwen3-VL-235B",
    context: 131072,
    output: 32768,
    reasoning: false,
    images: true,
  },
];

// Placeholder model injected when no credentials exist yet. It never routes to
// the gateway — its name carries the connect hint instead.
const HINT_MODEL_ID = "connect-required";

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
    // discovered models win; extras supplement without overriding
    const seen = new Set(discovered.map((m) => m.id));
    const models = [
      ...discovered,
      ...EXTRA_MODELS.filter((m) => !seen.has(m.id)),
    ];
    return { base, models, creds };
  } catch (e) {
    console.error(
      "[codearts-provider] model discovery failed, using extras only:",
      (e as Error)?.message ?? e,
    );
    return { base, models: EXTRA_MODELS, creds };
  }
}

const server: Plugin = async (_input, pluginOptions = {}) => {
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
        if (!existing || Object.keys(target.models ?? {}).length === 0) {
          const modelEntries: Record<string, ConfigModel> = {};
          for (const m of models ?? EXTRA_MODELS)
            modelEntries[m.id] = toConfigModel(m);
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
  };
  return hooks;
};

const mod: PluginModule = {
  id: "opencode-codearts-provider",
  server,
};

export default mod;
