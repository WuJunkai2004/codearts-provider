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
 *   V1 `options.fetch` → ctx.session.hook("http.request", ..., { providerID })
 *                        (the V2 replacement for injected fetch functions —
 *                        settings must stay JSON-safe)
 *
 * No `@opencode-ai/*` runtime import — the V2 host validates `{ id, setup }`
 * and injects everything else.
 */

import { signNativeRequest, isChatCompletionsUrl } from "../utils/signer.js";
import {
  guardChatResponse,
  isInferHubModerationError,
} from "../utils/sse.js";
import { autoCheckin } from "../utils/welfare.js";
import { registerQuotaRpc } from "../utils/quota-panel.js";
import { detectLangZH, getTranslations } from "../utils/i18n.js";
import { PROVIDER_ID } from "../utils/constants.js";
import {
  readStoredAuth,
  resolveBase,
  resolveDirectCreds,
} from "../utils/credentials.js";
import { fetchModels, hintModelInfo, toModelInfo } from "../utils/models.js";
import type {
  ConnectionInfo,
  CredentialValue,
  SessionHttpRequestEvent,
  SessionHttpResponseEvent,
  SessionRetryEvent,
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
    autoCheckin?: boolean;
  };
  const autoCheckinEnabled = options.autoCheckin !== false;
  const langZH = detectLangZH();
  const t = getTranslations(langZH);

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

  // Response counterpart: the gateway wraps pre-model failures (rate limit,
  // model not registered, invalid params) as HTTP 200 + a single pseudo-SSE
  // error line, which the SDK surfaces as the misleading "OpenAI Chat stream
  // ended without finish_reason". Rewrite it into a real non-2xx JSON error
  // (embedded status preserved, e.g. 429) so the host's retry/backoff and
  // error rendering see a normal protocol shape. No retry here — policy
  // belongs to the host.
  await ctx.session?.hook?.(
    "http.response",
    async (event: SessionHttpResponseEvent) => {
      if (event.model?.providerID !== PROVIDER_ID) return;
      if (!isChatCompletionsUrl(event.request.url)) return;
      try {
        event.response = await guardChatResponse(event.response);
      } catch {
        // guard failures must never break the exchange
      }
    },
    { providerID: PROVIDER_ID },
  );

  // Retry policy (docs/build/plugins/server → "Retry policy"): the host
  // classifies provider failures and the moderation family lands on
  // terminal classes (403 → AuthenticationError, 400 → InvalidRequestError).
  // But the gateway's wrapped `InferHub.ModelArts.81xxx` rejections are a
  // KNOWN-FLAKY backend content-moderation family in practice (81011.403
  // text refusal, 81001.400 "image_url.url field is unsafe" — 2026-11-07:
  // retry usually succeeds), so upgrade exactly those to a retryable
  // decision. Real account problems (APIG signature failures, also 403) and
  // deterministic rejections (001001005.400 invalid params, 002002009.404
  // not registered) never match the family and stay terminal; a proposed
  // retry (rate limits) keeps its own delay, and the host's built-in
  // attempt cap still bounds this.
  await ctx.session?.hook?.(
    "retry",
    async (event: SessionRetryEvent) => {
      if (event.model?.providerID !== PROVIDER_ID) return;
      if (event.decision.retry) return;
      if (!isInferHubModerationError(event.error?.message ?? "")) return;
      event.decision = { retry: true, delay: 2_000 };
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

  // V1 `tool` map: REMOVED. The old `codearts_vision` tool called a fixed
  // external vision model to describe images — that routing alias
  // (Qwen3-VL-235B) is gone from the gateway, and the main chat models now
  // take image parts natively (`supports_images` → Model.Info input
  // modality "image"), so there is nothing left for a vision helper to do.

  // Background refresh: re-discover models periodically and reload the
  // provider registry when the inventory changes (e.g. credentials were
  // connected after startup). Docs-documented reload pattern. The daily
  // welfare check-in rides the same heartbeat: the server's delivery state
  // is the truth, an in-memory day-guard makes it one delivery GET per
  // account per day, failures back off instead of retrying every minute.
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
      if (autoCheckinEnabled) {
        const creds = await resolveRequestCreds(ctx, options).catch(() => null);
        if (creds) {
          await autoCheckin({
            ak: creds.ak,
            sk: creds.sk,
            base: resolveBase({}, options),
            lang: langZH ? "zh-cn" : "en-us",
          });
        }
      }
    } catch {
      // keep the last good inventory
    } finally {
      refreshing = false;
    }
  };
  void registerQuotaRpc({
    register: ctx.rpc?.register,
    resolveCreds: () => resolveRequestCreds(ctx, options),
  }).catch(() => {});

  const timer = setInterval(() => void refresh().catch(() => {}), 60_000);
  return () => clearInterval(timer);
}
