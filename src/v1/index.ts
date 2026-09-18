import {
  tool,
  type Config,
  type Plugin,
  type Hooks,
  type ProviderHook,
  type AuthHook,
} from "@opencode-ai/plugin";
import type { Model, Provider, Auth } from "@opencode-ai/sdk/v2";
import { z } from "zod";
import { createSignedFetch } from "../utils/signer.js";
import { describeImage, imageToDataUrl } from "../utils/vision.js";
import { detectLangZH, getTranslations } from "../utils/i18n.js";
import {
  DEFAULT_VISION_MODEL,
  HINT_MODEL_ID,
  PROVIDER_ID,
  VISION_TOOL_ID,
  resolvePath,
} from "../utils/constants.js";
import {
  parseAuthEntry,
  resolveBase,
  resolveCreds,
  type StoredAuthEntry,
} from "../utils/credentials.js";
import { fetchModels, hintConfigModel, toConfigModel, toModel, type ConfigModel } from "../utils/models.js";

/**
 * V1 plugin function (docs/build/plugins/migrate-v1): returns the four hooks
 * — `config`, `provider`, `auth`, `tool`. Paired with the V2 `setup` in
 * `src/v2/index.ts` through the dual default export in `src/index.ts`.
 */
export const server: Plugin = async (_input, pluginOptions = {}) => {
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
    tool: visionEnabled ? { [VISION_TOOL_ID]: visionTool } : undefined,
  };
  return hooks;
};
