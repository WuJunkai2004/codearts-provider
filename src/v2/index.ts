/**
 * OpenCode V2 `setup(ctx)` — the docs/build/plugins/migrate-v1 mapping of the
 * V1 hooks in `src/v1/index.ts`:
 *
 *   V1 `config` hook   → ctx.provider.transform (source definition + models)
 *   V1 `provider` hook → models ride the provider definition; refresh via
 *                        ctx.provider.reload() after background re-discovery
 *   V1 `auth` hook     → ctx.integration.transform (key method + AK form);
 *                        credentials read per-request via
 *                        ctx.integration.connection.active/resolve
 *   V1 `tool` map      → ctx.tool.transform        (JSON Schema, structured result)
 *   V1 `options.fetch` → ctx.session.hook("http.request", ..., { providerID })
 *                        (the V2 replacement for injected fetch functions —
 *                        settings must stay JSON-safe)
 *
 * No `@opencode-ai/*` runtime import — the V2 host validates `{ id, setup }`
 * and injects everything else.
 */

import { signNativeRequest } from "../utils/signer.js";
import { describeImage, imageToDataUrl } from "../utils/vision.js";
import { detectLangZH, getTranslations } from "../utils/i18n.js";
import {
  DEFAULT_VISION_MODEL,
  PROVIDER_ID,
  VISION_TOOL_ID,
} from "../utils/constants.js";
import { resolvePath } from "../utils/paths.js";
import {
  readStoredAuth,
  resolveBase,
  resolveCreds,
  resolveDirectCreds,
} from "../utils/credentials.js";
import { fetchModels, hintModelInfo, toModelInfo } from "../utils/models.js";
import type {
  ConnectionInfo,
  CredentialValue,
  SessionHttpRequestEvent,
  V2Context,
} from "./types.js";

/** Credentials for request signing: plugin options > env > /connect
 * connection > auth.json. Resolved lazily — /connect credentials are
 * invisible on first boot, so the hook must not cache them at setup. */
async function resolveRequestCreds(
  ctx: V2Context,
  options: Record<string, unknown>,
): Promise<{ ak: string; sk: string } | null> {
  const direct = resolveDirectCreds({}, options);
  if (direct) return direct;
  const connection = (await ctx.integration?.connection?.active?.(
    PROVIDER_ID,
  )) as ConnectionInfo | undefined;
  if (connection) {
    try {
      const credential = (await ctx.integration?.connection?.resolve?.(
        connection,
      )) as CredentialValue | undefined;
      if (
        credential?.type === "key" &&
        typeof credential.key === "string" &&
        credential.key
      ) {
        const ak = credential.metadata?.ak;
        if (typeof ak === "string" && ak) return { ak, sk: credential.key };
      }
    } catch {
      // connection unresolvable — fall through to stored auth
    }
  }
  return readStoredAuth();
}

export async function setup(ctx: V2Context): Promise<(() => void) | void> {
  const options = ctx.options as {
    visionTool?: boolean;
    visionModel?: string;
  };
  const visionEnabled = options.visionTool !== false;
  const visionModel = options.visionModel ?? DEFAULT_VISION_MODEL;
  const t = getTranslations(detectLangZH());
  // V2 tool context carries no directory (unlike V1); capture the instance
  // location for resolving relative image paths.
  const directory = ctx.location?.directory ?? process.cwd();

  const base = resolveBase({}, options);

  // Same discovery/fallback semantics as the V1 config hook: discovered
  // models, else the cached list, else a single /connect hint model.
  const { models } = await fetchModels({}, options);
  const buildModels = (
    discovered: Awaited<ReturnType<typeof fetchModels>>["models"],
  ): Record<string, unknown>[] =>
    discovered && discovered.length > 0
      ? discovered.map((m) => toModelInfo(m))
      : [hintModelInfo()];

  // Mutable source: registry rebuilds replay the transform below, and a
  // background refresh mutates this and calls provider.reload().
  const source: { models: Record<string, unknown>[] } = {
    models: buildModels(models),
  };

  // Provider.Info per docs/build/plugins/effect: `activation: "enabled"`
  // keeps the provider registered (visible in /connect) even without
  // credentials. Settings MUST stay JSON-safe — the V2 registry clones
  // definitions, and a function (e.g. a fetch implementation) makes the
  // whole transform die with DataCloneError. Signing happens on the wire
  // via the http.request hook instead.
  await ctx.provider?.transform((editor) => {
    const info: Record<string, unknown> = {
      id: PROVIDER_ID,
      name: "Huawei CodeArts",
      activation: "enabled",
      package: "@opencode/ai/providers/openai-compatible",
      // links provider ↔ integration ↔ stored credential: without it the
      // /connect flow never associates the connection with this provider
      // (models.dev-sourced providers all carry this field).
      integrationID: PROVIDER_ID,
      settings: {
        baseURL: `${base}/api/v2`,
        // placeholder: satisfies the bearer-auth requirement of the
        // openai-compatible package; replaced by the SDK-HMAC-SHA256
        // Authorization header in the http.request hook.
        apiKey: "codearts-signed",
      },
    };
    if (typeof editor.add === "function") {
      editor.add({ info, models: source.models });
    } else if (typeof editor.update === "function") {
      editor.update(PROVIDER_ID, (provider: any) => {
        Object.assign(provider, info);
      });
      editor.models?.set(PROVIDER_ID, source.models);
    }
  });

  // V1 `options.fetch` replacement: sign the native provider request for
  // every model call (agent loop, compaction, title, generate). Scoped to
  // this provider; credentials resolved per request.
  await ctx.session?.hook?.(
    "http.request",
    async (event: SessionHttpRequestEvent) => {
      if (event.model?.providerID !== PROVIDER_ID) return;
      const creds = await resolveRequestCreds(ctx, options);
      if (!creds) return;
      event.request = await signNativeRequest(
        event.request,
        creds.ak,
        creds.sk,
        event.sessionID,
      );
    },
    { providerID: PROVIDER_ID },
  );

  // V1 `auth`: set the integration display name, then register the key
  // method. The key method collects the SK (stored credential key); the form
  // collects the AK — the two-step /connect flow, V2-shaped.
  await ctx.integration?.transform((editor) => {
    if (typeof editor.update === "function") {
      editor.update(PROVIDER_ID, (integration) => {
        integration.name = "Huawei CodeArts";
      });
    }
    editor.method?.update({
      integrationID: PROVIDER_ID,
      method: {
        type: "key",
        label: t.skTitle,
        form: [
          {
            key: "ak",
            type: "string",
            title: t.akPrompt,
            placeholder: t.akPlaceholder,
            required: true,
          },
        ],
      },
    });
  });

  // V1 `tool`: JSON Schema in, structured content out. Credentials are still
  // resolved lazily at call time (/connect creds are invisible on first boot).
  if (visionEnabled) {
    await ctx.tool?.transform((editor) => {
      editor.add({
        name: VISION_TOOL_ID,
        description: t.visionToolDescription,
        input: {
          type: "object",
          properties: {
            image: {
              type: "string",
              description: "Local image file path (png/jpg/jpeg/gif/webp/bmp)",
            },
            image_url: {
              type: "string",
              description: "Remote image URL or data: URL",
            },
            prompt: {
              type: "string",
              description: "What to ask about the image (default: describe it)",
            },
          },
          additionalProperties: false,
        },
        execute: async (input) => {
          const creds = resolveCreds({}, ctx.options);
          if (!creds) throw new Error(t.visionNoCreds);

          let dataUrl: string;
          if (input.image) {
            dataUrl = imageToDataUrl(resolvePath(directory, input.image));
          } else if (input.image_url) {
            dataUrl = input.image_url;
          } else {
            throw new Error(t.visionNoImage);
          }
          const out = await describeImage({
            ak: creds.ak,
            sk: creds.sk,
            base: resolveBase({}, ctx.options),
            model: visionModel,
            image: { dataUrl },
            prompt: input.prompt ?? t.visionDefaultPrompt,
          });
          if (!out) throw new Error(t.visionEmpty);
          return { content: out };
        },
      });
    });
  }

  // Background refresh: re-discover models periodically and reload the
  // provider registry when the inventory changes (e.g. credentials were
  // connected after startup). Docs-documented reload pattern.
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const { models: next } = await fetchModels({}, options);
      const nextModels = buildModels(next);
      if (JSON.stringify(nextModels) !== JSON.stringify(source.models)) {
        source.models = nextModels;
        await ctx.provider?.reload?.();
      }
    } catch {
      // keep the last good inventory
    } finally {
      refreshing = false;
    }
  };
  const timer = setInterval(() => void refresh().catch(() => {}), 60_000);
  return () => clearInterval(timer);
}
