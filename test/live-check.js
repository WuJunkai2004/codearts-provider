import { signRequest } from "../.tsc/utils/signer.js";

const AK = process.env.CODEARTS_CLI_AK;
const SK = process.env.CODEARTS_CLI_SK;
const BASE = "https://snap-access.cn-north-4.myhuaweicloud.com";

const headers = signRequest(
  "GET",
  `${BASE}/v1/agent-center/agents/useragents?offset=0&limit=100`,
  AK,
  SK,
  {
    "Content-Type": "application/json",
    "X-Language": "zh-cn",
    "Agent-Type": "AgentCenter",
  },
);

const res = await fetch(
  `${BASE}/v1/agent-center/agents/useragents?offset=0&limit=100`,
  { headers },
);
console.log("status:", res.status);
const text = await res.text();
console.log(text.slice(0, 200));

// --- welfare (daily check-in) smoke: delivery status only, no claim ---
import { fetchWelfareDelivery, autoCheckin } from "../.tsc/utils/welfare.js";

const wreq = { ak: AK, sk: SK, base: BASE, lang: "zh-cn" };
const campaigns = await fetchWelfareDelivery(wreq);
for (const c of campaigns) {
  console.log(
    `welfare: #${c.campaignId} ${c.title} [${c.type}] status=${c.status ?? "null"} claimable=${c.claimable}`,
  );
}
console.log(
  "autoCheckin:",
  (await autoCheckin(wreq)) ?? "(already done today or nothing claimable)",
);

// --- quota panel probes -----------------------------------------------------
// 1) opengw benefit balance: AK/SK-signed plain GET (no CLI chat shape),
//    same signing as the gateway/config discovery. Expected envelope
//    {error_code:"0000", result:{...}} — result fields power the panel
//    (total_quota/used_amount, monthly_token_limit/monthly_tokens_used).
// 2) snap-access statistics/plugin: the package quota. The official CLI
//    polls it with plain AK/SK signing + `Agent-Type: PromptCenter`
//    (reverse-engineered from codearts.exe) — expected to work; the IDE
//    instead uses its own x-auth-token.
import { OPENGW_BASE } from "../.tsc/utils/constants.js";
import {
  groupsFromBalance,
  groupsFromSubscription,
} from "../.tsc/utils/quota-panel.js";

{
  const balHeaders = signRequest(
    "GET",
    `${OPENGW_BASE}/api/v1/user/tokens/balance`,
    AK,
    SK,
    {
      "Content-Type": "application/json",
    },
  );
  const balRes = await fetch(`${OPENGW_BASE}/api/v1/user/tokens/balance`, {
    headers: balHeaders,
  });
  console.log("\n[opengw] /api/v1/user/tokens/balance status:", balRes.status);
  const balText = await balRes.text();
  console.log(balText.slice(0, 600));
  try {
    const json = JSON.parse(balText);
    if (json?.error_code === "0000" && json?.result) {
      // Served by the codearts.quota/status RPC (see utils/quota-panel.ts).
      console.log(
        "[opengw] panel groups would be:",
        groupsFromBalance(json.result, true),
      );
    }
  } catch {}
}

{
  const statHeaders = signRequest(
    "GET",
    `${BASE}/snap-manager/v1/statistics/plugin`,
    AK,
    SK,
    {
      "Content-Type": "application/json",
      "Agent-Type": "PromptCenter",
    },
  );
  const statRes = await fetch(`${BASE}/snap-manager/v1/statistics/plugin`, {
    headers: statHeaders,
  });
  // The official CLI (codearts.exe, an opencode fork) polls this endpoint
  // every 10 min with exactly this AK/SK signature + Agent-Type header —
  // it is expected to WORK (the IDE instead uses its x-auth-token).
  console.log(
    "\n[snap-access] /snap-manager/v1/statistics/plugin status:",
    statRes.status,
  );
  const statText = await statRes.text();
  console.log(statText.slice(0, 800));
  try {
    const json = JSON.parse(statText);
    console.log(
      "[snap-access] panel groups would be:",
      groupsFromSubscription(json, true),
    );
  } catch {}
}
