/**
 * Quota RPC — serves a CodeArts quota snapshot to the opencode-glm-vistatus
 * sidebar over the host's plugin-RPC channel.
 *
 * This plugin registers `codearts.quota` with a `status` method (host
 * contract: `ctx.rpc.register`, available since v2.0.25; the promise
 * adapter wires it into the core RPC service). The TUI panel pulls it via
 * `client.rpc.call` → `POST /api/rpc/codearts.quota/status`. Output shape —
 * the cross-plugin contract:
 *
 *   { label: string, groups: [{ title, bar, resetTime? }] }
 *
 * where `bar` is "nn%" or "xx/yy" (the reader derives fill/color from it)
 * and `title` / `resetTime` are display-ready strings — THIS side owns
 * i18n. Handlers are best-effort: any failure degrades to an empty group
 * list, which the reader renders as "no data for this provider" (the GLM
 * view falls back). A 4-min result cache absorbs the panel's 30s polling
 * (the official CLI itself polls statistics/plugin every 10 min).
 *
 * Data sources (both AK/SK signed, mirroring the official CLI — see
 * REVERSE-ENGINEERING-CLI.md):
 *
 * 1. Package quota — snap-access `GET /snap-manager/v1/statistics/plugin`.
 *    The CLI's subscription-tip service polls this exact endpoint every
 *    10 min with plain AK/SK signing (`Content-Type` +
 *    `Agent-Type: PromptCenter`) — no IDE `x-auth-token` needed. Consumed
 *    fields: `metrics[]` entries found by `name` — `usageTokenChatMessages`
 *    (`usage_token_num` / `package_token_amount`) and
 *    `usageTotalPackageCredit` (`package_credit_amount` / `_used`), plus
 *    `package.end_date` (cycle end).
 * 2. Benefit balance — opengw `GET /api/v1/user/tokens/balance`, envelope
 *    `{error_code:"0000", result:{...}}`; the fields the IDE webview
 *    renders: `maas_type`, `total_quota` / `used_amount` (benefit tokens)
 *    and `monthly_token_limit` / `monthly_tokens_used` (education).
 */

import { OPENGW_BASE, PROVIDER_ID } from "./constants.js";
import { createSignedFetch } from "./signer.js";
import { DEFAULT_BASE } from "./discover.js";
import { detectLangZH } from "./i18n.js";

export interface QuotaPanelGroup {
  readonly title: string;
  readonly bar: string;
  readonly resetTime?: string;
}

/** The `status` method output — the cross-plugin contract. */
export interface QuotaSnapshot {
  readonly label: string;
  readonly groups: readonly QuotaPanelGroup[];
}

export const PROVIDER_LABEL = "CodeArts";

/** Result cache TTL: the panel polls every 30s; the upstream data barely
 * changes within minutes and statistics/plugin is a 10-min-cycle feed. */
const SNAPSHOT_CACHE_MS = 4 * 60_000;

/** Balance result — only the fields the IDE actually renders. */
export interface TokenBalanceResult {
  readonly maas_type?: string;
  readonly total_quota?: number;
  readonly used_amount?: number;
  readonly monthly_token_limit?: number;
  readonly monthly_tokens_used?: number;
  readonly [key: string]: unknown;
}

/**
 * Compact token counts for a `xx/yy` bar: K/M suffixes with one decimal
 * (the reader's ratio parser understands them and derives the percentage
 * from the pair, so nothing is lost).
 */
export function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Benefit/education groups from a balance result; empty when unusable. */
export function groupsFromBalance(
  result: TokenBalanceResult,
  langZH = detectLangZH(),
): QuotaPanelGroup[] {
  const groups: QuotaPanelGroup[] = [];
  const total = result.total_quota;
  const used = result.used_amount;
  if (typeof total === "number" && total > 0 && typeof used === "number") {
    groups.push({
      title: langZH ? "权益额度" : "Benefit",
      bar: `${compactTokens(used)}/${compactTokens(total)}`,
    });
  }
  const limit = result.monthly_token_limit;
  const monthly = result.monthly_tokens_used;
  if (typeof limit === "number" && limit > 0 && typeof monthly === "number") {
    groups.push({
      title: langZH ? "教育额度" : "Education",
      bar: `${compactTokens(monthly)}/${compactTokens(limit)}`,
    });
  }
  return groups;
}

/**
 * Fetch the opengw benefit balance with the snap-access AK/SK (plain
 * signed GET — no CLI chat shape, mirroring the gateway/config discovery).
 * Returns null on any failure; the caller just skips those groups.
 */
export async function fetchTokenBalance(
  ak: string,
  sk: string,
): Promise<TokenBalanceResult | null> {
  try {
    const doFetch = createSignedFetch(ak, sk);
    const res = await doFetch(`${OPENGW_BASE}/api/v1/user/tokens/balance`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as {
      error_code?: string;
      result?: unknown;
    } | null;
    if (!json || json.error_code !== "0000") return null;
    if (typeof json.result !== "object" || json.result === null) return null;
    return json.result as TokenBalanceResult;
  } catch {
    return null;
  }
}

/**
 * Package subscription info — the fields this plugin consumes from
 * `statistics/plugin` (superset of what the CLI's subscription-tip and the
 * IDE's package view read).
 */
export interface SubscriptionInfo {
  readonly is_white_list?: boolean;
  readonly show?: { readonly metrics?: boolean; readonly package?: boolean };
  /** Package cycle (top level — NOT inside `package`). */
  readonly start_date?: string;
  readonly end_date?: string;
  readonly package?: {
    readonly status?: string;
    readonly spec_code?: string;
    /** false → credit-package account (体验版): there is NO token quota. */
    readonly is_token_package?: boolean;
    readonly is_credit_package?: boolean;
  };
  /**
   * Entries are found by `name`; `show: false` hides the metric from the
   * official UIs too. Field semantics differ by package type: for a token
   * package `usage_token_num`/`package_token_amount` are used/total, but a
   * credit-package account (体验版) gets the PLACEHOLDER `package_token_amount`
   * = 1 with the cycle's cumulative usage in `usage_token_num` (live-verified
   * 2026-10-14) — that pair must not be rendered as a bar.
   */
  readonly metrics?: readonly {
    readonly name?: string;
    readonly show?: boolean;
    readonly usage_token_num?: number;
    readonly package_token_amount?: number;
    readonly package_credit_amount?: number;
    readonly package_credit_used?: number;
    readonly package_credit_remain?: number;
  }[];
}

/**
 * Fetch the package quota with plain AK/SK signing. Headers mirror the
 * CLI's signed-request helper exactly: `Content-Type: application/json` +
 * `Agent-Type: PromptCenter` (the IDE instead authenticates with its
 * `x-auth-token`; the CLI proves AK/SK is accepted). Returns null on any
 * failure; the caller just skips those groups.
 */
export async function fetchSubscriptionInfo(
  ak: string,
  sk: string,
  base: string = DEFAULT_BASE,
): Promise<SubscriptionInfo | null> {
  try {
    const doFetch = createSignedFetch(ak, sk);
    const res = await doFetch(`${base}/snap-manager/v1/statistics/plugin`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Agent-Type": "PromptCenter",
      },
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object") return null;
    return json as SubscriptionInfo;
  } catch {
    return null;
  }
}

function findMetric(
  metrics: SubscriptionInfo["metrics"],
  name: string,
): Record<string, unknown> | undefined {
  for (const m of metrics ?? []) {
    if (m?.name === name) return m as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Groups from the package quota: the token package usage (primary quota for
 * token-package accounts), then the general-purpose credit pool (the ONLY
 * package quota for 体验版 credit accounts). Order matters — the package
 * group renders first in the panel.
 */
export function groupsFromSubscription(
  info: SubscriptionInfo | null,
  langZH = detectLangZH(),
): QuotaPanelGroup[] {
  if (!info) return [];
  const groups: { title: string; bar: string; resetTime?: string }[] = [];

  // Cycle end lives at the TOP level of the response (2026-10-14 finding;
  // `package.end_date` does not exist in the real payload).
  const expiry = typeof info.end_date === "string" ? info.end_date.trim() : "";
  const expiryLine = expiry
    ? langZH
      ? `到期: ${expiry}`
      : `Expires: ${expiry}`
    : undefined;

  // Token package: render only when the account actually HAS one. A
  // placeholder total (≤1) or an explicit credit package means there is no
  // token quota — usage_token_num alone is cumulative usage, not a ratio.
  const hasTokenPackage = info.package?.is_token_package !== false;
  const token = findMetric(info.metrics, "usageTokenChatMessages");
  const total = token?.package_token_amount;
  const used = token?.usage_token_num;
  if (
    hasTokenPackage &&
    token?.show !== false &&
    typeof total === "number" &&
    total > 1 &&
    typeof used === "number"
  ) {
    groups.push({
      title: langZH ? "套餐额度" : "Package",
      bar: `${compactTokens(used)}/${compactTokens(total)}`,
    });
  }

  // Credits: amount/used pool — the primary quota of credit-package accounts.
  const credit = findMetric(info.metrics, "usageTotalPackageCredit");
  const creditAmount = credit?.package_credit_amount;
  const creditUsed = credit?.package_credit_used;
  if (
    credit?.show !== false &&
    typeof creditAmount === "number" &&
    creditAmount > 0 &&
    typeof creditUsed === "number"
  ) {
    groups.push({
      title: langZH ? "通用积分" : "Credits",
      bar: `${compactTokens(creditUsed)}/${compactTokens(creditAmount)}`,
    });
  }

  // The cycle end qualifies the first statistics group (package if present,
  // else credits).
  if (expiryLine && groups.length > 0 && !groups[0].resetTime) {
    groups[0].resetTime = expiryLine;
  }

  return groups;
}

/** Injectable upstream fetchers (tests stub these; defaults hit the wire). */
export interface QuotaFetchers {
  readonly subscription: typeof fetchSubscriptionInfo;
  readonly balance: typeof fetchTokenBalance;
}

/**
 * Fetch both sources in parallel and merge into one snapshot — package
 * groups first, then benefit/education. A failing source just contributes
 * no groups; total failure yields an empty list.
 */
export async function fetchQuotaSnapshot(
  ak: string,
  sk: string,
  base: string = DEFAULT_BASE,
  fetchers: QuotaFetchers = {
    subscription: fetchSubscriptionInfo,
    balance: fetchTokenBalance,
  },
  langZH: boolean = detectLangZH(),
): Promise<QuotaSnapshot> {
  const [subscription, balance] = await Promise.all([
    fetchers.subscription(ak, sk, base),
    fetchers.balance(ak, sk),
  ]);
  return {
    label: PROVIDER_LABEL,
    groups: [
      ...groupsFromSubscription(subscription, langZH),
      ...groupsFromBalance(balance ?? {}, langZH),
    ],
  };
}

/** Minimal structural type of the host's `ctx.rpc.register` (≥ v2.0.25). */
export type RpcRegister = (
  definition: {
    readonly id: string;
    readonly methods: Record<
      string,
      { readonly input: unknown; readonly output: unknown }
    >;
    readonly events: Record<string, unknown>;
  },
  handlers: Record<
    string,
    (
      input: unknown,
      context: { readonly signal: AbortSignal },
    ) => Promise<unknown>
  >,
) => Promise<unknown>;

/**
 * Register the `codearts.quota` RPC (pull-based — no timer of its own).
 * `resolveCreds` runs per cache miss so rotated/re-connected credentials
 * are picked up; all failures degrade to an empty group list. A host
 * without the rpc domain makes this a safe no-op (returns false).
 */
export async function registerQuotaRpc(options: {
  readonly register: RpcRegister | undefined;
  readonly resolveCreds: () => Promise<{ ak: string; sk: string } | null>;
  readonly base?: string;
  readonly fetchers?: QuotaFetchers;
}): Promise<boolean> {
  const { register } = options;
  if (!register) return false;

  let cache: { at: number; groups: readonly QuotaPanelGroup[] } | null = null;

  await register(
    {
      id: `${PROVIDER_ID}.quota`,
      methods: {
        status: {
          input: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          output: { type: "object" },
        },
      },
      events: {},
    },
    {
      status: async (): Promise<QuotaSnapshot> => {
        if (cache && Date.now() - cache.at < SNAPSHOT_CACHE_MS) {
          return { label: PROVIDER_LABEL, groups: cache.groups };
        }
        let groups: readonly QuotaPanelGroup[] = [];
        try {
          const creds = await options.resolveCreds();
          if (creds) {
            ({ groups } = await fetchQuotaSnapshot(
              creds.ak,
              creds.sk,
              options.base,
              options.fetchers,
            ));
          }
        } catch {
          // best-effort: degrade to "no data"
        }
        cache = { at: Date.now(), groups };
        return { label: PROVIDER_LABEL, groups };
      },
    },
  );
  return true;
}
