import {
  tool,
  type Config,
  type Plugin,
  type Hooks,
  type ProviderHook,
  type AuthHook,
} from "@opencode-ai/plugin";
import type { Model, Provider, Auth } from "@opencode-ai/sdk/v2";
import { createSignedFetch } from "../utils/signer.js";
import { autoCheckin } from "../utils/welfare.js";
import { detectLangZH, getTranslations } from "../utils/i18n.js";
import { HINT_MODEL_ID, PROVIDER_ID } from "../utils/constants.js";
import {
  parseAuthEntry,
  resolveBase,
  resolveCreds,
  type StoredAuthEntry,
} from "../utils/credentials.js";
import { fetchModels, hintConfigModel, toConfigModel, toModel, type ConfigModel } from "../utils/models.js";

/**
 * V1 plugin function (docs/build/plugins/migrate-v1): returns the `config`,
 * `provider` and `auth` hooks. Paired with the V2 `setup` in
 * `src/v2/index.ts` through the dual default export in `src/index.ts`.
 *
 * There is deliberately NO `tool` hook: the gateway's main chat models take
 * image parts natively (`supports_images`), so the old external
 * vision-model helper tool (`codearts_vision` → Qwen3-VL-235B) is gone —
 * that routing alias no longer exists on the gateway, and pasting an image
 * into a multimodal model flows straight through the chat body.
 */
export const server: Plugin = async (_input, pluginOptions = {}) => {
  const po = pluginOptions as {
    autoCheckin?: boolean;
  };
  const autoCheckinEnabled = po.autoCheckin !== false;
  const langZH = detectLangZH();
  const t = getTranslations(langZH);

  const hooks: Hooks = {
    // Runs before opencode reads cfg.provider. The provider is ALWAYS
    // registered (so it shows up in /connect even without credentials);
    // the signed fetch is only injected when credentials exist.
    config: async (config: Config) => {
      // Daily welfare check-in (每日签到领积分): fire-and-forget so a network
      // hiccup never delays startup; the server's delivery state is the
      // "already claimed today" truth, guarded in memory (no state file).
      if (autoCheckinEnabled) {
        const creds = resolveCreds({}, pluginOptions);
        if (creds) {
          void autoCheckin({
            ak: creds.ak,
            sk: creds.sk,
            base: resolveBase({}, pluginOptions),
            lang: langZH ? "zh-cn" : "en-us",
          }).catch(() => {});
        }
      }
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
          [HINT_MODEL_ID]: hintConfigModel(),
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
