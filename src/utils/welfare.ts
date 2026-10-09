import { createSignedFetch } from "./signer.js";

/**
 * CodeArts welfare (权益/签到) API — reverse-engineered from the VSCode
 * extension's `TUi` handler (out/extension.js):
 *
 *   delivery : GET  {base}/v1/ops/delivery?channel=IDE   campaign list + status
 *   claim    : POST {base}/v1/ops/claim                  {campaignId, idempotentKey, channel}
 *   confirm  : POST {base}/v1/ops/confirm                {campaignId} (auto after claim)
 *
 * Same snap-access host and the same SDK-HMAC-SHA256 AK/SK signing as every
 * other endpoint here, but these are PLAIN signed requests: no CLI chat shape
 * (they are discovery-like), hence no user-session-id and no session slot.
 * The extension sends `Agent-Type: PromptCenter` + an empty `x-auth-token`;
 * mirrored here for exactness.
 */

export type WelfareCampaign = {
  campaignId: number;
  title: string;
  /** USER_LOGIN = the daily check-in; INVITE_USER / STUDENT_CERTIFIED / … */
  type: string;
  /** ELIGIBLE (claimable now) / CLAIMED / CONFIRMED / CONSUMED / null. */
  status: string | null;
  /** Server-side "can be claimed right now" flag. */
  claimable: boolean;
  benefitAmount?: number;
  benefitUnit?: string;
  description?: string;
};

export type WelfareRequest = {
  ak: string;
  sk: string;
  base: string;
  lang?: string;
  fetchImpl?: typeof fetch;
};

export type ClaimOutcome = {
  campaignId: number;
  title: string;
  /** Final status after claim (+ confirm): CLAIMED or CONFIRMED. */
  status: string;
  amount?: number;
  unit?: string;
};

/** Minimal status subset the IDE treats as "already claimed this period". */
const CLAIMED_STATUSES = new Set(["CLAIMED", "CONFIRMED", "CONSUMED"]);

function welfareHeaders(lang: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-auth-token": "",
    "x-snap-traceid": crypto.randomUUID().replace(/-/g, ""),
    "Agent-Type": "PromptCenter",
    "X-Language": lang,
  };
}

/** One cached signed-fetch instance per AK (matches vision.ts; these
 * requests carry no session id, so no slot is consumed either way). */
const welfareFetchByAk = new Map<
  string,
  ReturnType<typeof createSignedFetch>
>();

function welfareFetch(ak: string, sk: string) {
  let doFetch = welfareFetchByAk.get(ak);
  if (!doFetch) {
    doFetch = createSignedFetch(ak, sk);
    welfareFetchByAk.set(ak, doFetch);
  }
  return doFetch;
}

/** ops responses are enveloped as {code, message, data}; code !== 0 throws. */
function unwrap<T>(json: unknown): T {
  const env = json as { code?: number; message?: string; data?: T };
  if (
    env &&
    typeof env === "object" &&
    env.code !== undefined &&
    env.code !== 0
  ) {
    throw new Error(
      `welfare api error: code=${env.code} ${env.message ?? ""}`.trim(),
    );
  }
  return (env?.data ?? (json as T)) as T;
}

async function welfareCall<T>(
  req: WelfareRequest,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const doFetch = req.fetchImpl ?? welfareFetch(req.ak, req.sk);
  const res = await doFetch(`${req.base.replace(/\/$/, "")}${path}`, {
    method,
    headers: welfareHeaders(req.lang ?? "zh-cn"),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    // bounded: the auto check-in must never hang a host's refresh cycle
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `welfare ${method} ${path} failed: HTTP ${res.status} ${detail.slice(0, 300)}`,
    );
  }
  return unwrap<T>(await res.json());
}

type DeliveryItem = {
  campaignId?: number;
  title?: string;
  type?: string;
  status?: string | null;
  claimable?: boolean;
  benefitAmount?: number;
  benefitUnit?: string;
  description?: string;
};

/** Lists welfare campaigns with their claim status. */
export async function fetchWelfareDelivery(
  req: WelfareRequest,
): Promise<WelfareCampaign[]> {
  const data = await welfareCall<{ items?: DeliveryItem[] }>(
    req,
    "GET",
    "/v1/ops/delivery?channel=IDE",
  );
  return (data?.items ?? []).map((it) => ({
    campaignId: it.campaignId ?? -1,
    title: it.title ?? "",
    type: it.type ?? "",
    status: it.status ?? null,
    claimable: Boolean(it.claimable),
    benefitAmount: it.benefitAmount,
    benefitUnit: it.benefitUnit,
    description: it.description,
  }));
}

/** Claims one campaign; mirrors the IDE flow: a successful claim is followed
 * by confirm (which also surfaces the credit-bucket totals). Idempotent on
 * the server: re-claiming a CLAIMED/CONFIRMED/CONSUMED campaign is a no-op. */
export async function claimWelfareCampaign(
  req: WelfareRequest,
  campaignId: number,
): Promise<ClaimOutcome> {
  const claimed = await welfareCall<{
    campaignId?: number;
    status?: string;
    campaignTitle?: string;
    totalAmount?: number;
  }>(req, "POST", "/v1/ops/claim", {
    campaignId,
    idempotentKey: `claim_${campaignId}_${Date.now()}`,
    channel: "IDE",
  });
  const status = String(claimed?.status ?? "").toUpperCase();
  const outcome: ClaimOutcome = {
    campaignId,
    title: claimed?.campaignTitle ?? "",
    status: status || "UNKNOWN",
    amount: claimed?.totalAmount,
    unit: "CREDIT",
  };
  if (claimed?.campaignId != null && status === "CLAIMED") {
    // fresh claim → confirm like the IDE does; best-effort
    try {
      const confirmed = await welfareCall<{ status?: string }>(
        req,
        "POST",
        "/v1/ops/confirm",
        { campaignId: claimed.campaignId },
      );
      const cs = String(confirmed?.status ?? "").toUpperCase();
      if (cs) outcome.status = cs;
    } catch {
      // claimed but unconfirmed: the credit still lands, state stays CLAIMED
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Daily auto check-in — server-state driven (the atomcode-provider pattern):
//   * the delivery endpoint IS the "checked in today" truth (`claimable` /
//     `status`); no local state file — multi-instance hosts can't disagree
//     with the server, a process restart simply re-probes once
//   * an in-memory day-guard keeps the periodic probe cheap (one delivery GET
//     per account per local day per process) and a failure backoff avoids
//     hammering the gateway every refresh cycle
//   * claim idempotency is the server's job (CLAIMED/CONFIRMED/CONSUMED)
//   * silent at runtime by design — there is NO LLM tool for welfare
//     (deterministic account mutations must not be model-triggered);
//     diagnose via test/live-check.js or the ops endpoints directly
// ---------------------------------------------------------------------------

export type CheckinOutcome = {
  /** Local calendar day the attempt belongs to ("YYYY-MM-DD"). */
  day: string;
  result: "claimed" | "already" | "failed";
  /** Human-readable one-liner: campaign, final status, amount / error. */
  detail: string;
  at: number;
};

/** After a failed attempt, wait this long before probing the server again. */
const CHECKIN_BACKOFF_MS = 10 * 60_000;

const checkinMem = new Map<string, { okDay?: string; last?: CheckinOutcome }>();

const mkOutcome = (
  day: string,
  now: Date,
  result: CheckinOutcome["result"],
  detail: string,
): CheckinOutcome => ({ day, result, detail, at: now.getTime() });

/**
 * Best-effort daily check-in for the USER_LOGIN campaign (每日签到). Returns
 * null when skipped (already probed today / failure backoff) — never throws.
 */
export async function autoCheckin(
  req: WelfareRequest,
  now: Date = new Date(),
): Promise<CheckinOutcome | null> {
  const day = localDateString(now);
  const m = checkinMem.get(req.ak) ?? {};
  checkinMem.set(req.ak, m);
  if (m.okDay === day) return null;
  if (
    m.last?.result === "failed" &&
    m.last.day === day &&
    now.getTime() - m.last.at < CHECKIN_BACKOFF_MS
  ) {
    return null;
  }
  let outcome: CheckinOutcome;
  try {
    const campaigns = await fetchWelfareDelivery(req);
    const login = campaigns.find((c) => c.type === "USER_LOGIN");
    const daily =
      login && (login.claimable || login.status === "ELIGIBLE") ? login : null;
    if (!daily) {
      // The server says there is nothing to claim today — trust it, stop probing.
      m.okDay = day;
      outcome = mkOutcome(
        day,
        now,
        "already",
        login
          ? `#${login.campaignId} status=${login.status ?? "null"}`
          : "no USER_LOGIN campaign on delivery",
      );
    } else {
      try {
        const out = await claimWelfareCampaign(req, daily.campaignId);
        if (CLAIMED_STATUSES.has(out.status)) {
          m.okDay = day;
          const amount =
            out.amount != null ? ` +${out.amount} ${out.unit ?? "CREDIT"}` : "";
          outcome = mkOutcome(
            day,
            now,
            "claimed",
            `#${out.campaignId} "${out.title || daily.title}" -> ${out.status}${amount}`,
          );
        } else {
          outcome = mkOutcome(
            day,
            now,
            "failed",
            `unexpected claim status ${out.status}`,
          );
        }
      } catch (e) {
        outcome = mkOutcome(day, now, "failed", String(e).slice(0, 200));
      }
    }
  } catch (e) {
    // delivery itself failed: back off (no okDay — retried after the window)
    outcome = mkOutcome(day, now, "failed", String(e).slice(0, 200));
  }
  m.last = outcome;
  return outcome;
}

/** Local calendar date (the check-in resets per local day; the account is
 * CN-region so local time == the server's notion of "today" for this base). */
export function localDateString(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
