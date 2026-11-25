import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compactTokens,
  fetchQuotaSnapshot,
  groupsFromBalance,
  groupsFromSubscription,
  registerQuotaRpc,
} from "../.tsc/utils/quota-panel.js";

test("compactTokens: K/M suffixes mirror the panel's ratio parser", () => {
  assert.equal(compactTokens(0), "0");
  assert.equal(compactTokens(9999), "9999");
  assert.equal(compactTokens(15_000), "15.0K");
  assert.equal(compactTokens(12_500_000), "12.5M");
});

test("groupsFromBalance: benefit + education groups from IDE-rendered fields", () => {
  const groups = groupsFromBalance(
    {
      maas_type: "benefit",
      total_quota: 5_000_000,
      used_amount: 2_500_000,
      monthly_token_limit: 10_000_000,
      monthly_tokens_used: 1_000_000,
    },
    true,
  );
  assert.deepEqual(groups, [
    { title: "权益额度", bar: "2.5M/5.0M" },
    { title: "教育额度", bar: "1.0M/10.0M" },
  ]);
});

test("groupsFromBalance: english titles", () => {
  const groups = groupsFromBalance(
    { total_quota: 100, used_amount: 25 },
    false,
  );
  assert.deepEqual(groups, [{ title: "Benefit", bar: "25/100" }]);
});

test("groupsFromBalance: missing/zero denominators yield nothing", () => {
  assert.deepEqual(groupsFromBalance({}, true), []);
  assert.deepEqual(
    groupsFromBalance({ total_quota: 0, used_amount: 1 }, true),
    [],
  );
  // used_amount missing → the pair is not renderable, no group
  assert.deepEqual(groupsFromBalance({ total_quota: 100 }, true), []);
});

// ---- RPC channel (host contract: ctx.rpc.register, ≥ v2.0.25) --------------

const STUB_FETCHERS = {
  subscription: async () => subscriptionResponse(),
  balance: async () => ({
    total_quota: 100,
    used_amount: 25,
    monthly_token_limit: 1000,
    monthly_tokens_used: 250,
  }),
};

test("fetchQuotaSnapshot: merges package groups first, then benefit/education", async () => {
  const snap = await fetchQuotaSnapshot(
    "AK",
    "SK",
    "https://base",
    STUB_FETCHERS,
    true,
  );
  assert.equal(snap.label, "CodeArts");
  assert.deepEqual(
    snap.groups.map((g) => g.title),
    ["套餐额度", "通用积分", "权益额度", "教育额度"],
  );
  assert.equal(snap.groups[0].bar, "2.5M/10.0M");
  assert.equal(snap.groups[2].bar, "25/100");
  assert.equal(snap.groups[3].bar, "250/1000");
});

test("fetchQuotaSnapshot: a failing source contributes no groups", async () => {
  const snap = await fetchQuotaSnapshot("AK", "SK", "https://base", {
    subscription: async () => null,
    balance: async () => null,
  });
  assert.deepEqual(snap.groups, []);
});

/** Capturing fake of ctx.rpc.register. */
function fakeRegister() {
  const calls = [];
  const handlers = {};
  const register = async (definition, h) => {
    calls.push(definition);
    Object.assign(handlers, h);
  };
  return { register, calls, handlers };
}

test("registerQuotaRpc: registers codearts.quota/status and caches results", async () => {
  const fake = fakeRegister();
  let credsReads = 0;
  let upstreamReads = 0;
  const fetchers = {
    subscription: async () => {
      upstreamReads++;
      return subscriptionResponse();
    },
    balance: async () => ({ total_quota: 100, used_amount: 25 }),
  };
  const ok = await registerQuotaRpc({
    register: fake.register,
    resolveCreds: async () => {
      credsReads++;
      return { ak: "AK", sk: "SK" };
    },
    fetchers,
  });
  assert.equal(ok, true);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].id, "codearts.quota");
  assert.deepEqual(Object.keys(fake.calls[0].methods), ["status"]);
  assert.deepEqual(Object.keys(fake.handlers), ["status"]);

  // First call fetches; second call inside the cache window does not.
  const first = await fake.handlers.status(
    {},
    { signal: new AbortController().signal },
  );
  const second = await fake.handlers.status(
    {},
    { signal: new AbortController().signal },
  );
  assert.equal(first.label, "CodeArts");
  assert.deepEqual(first, second);
  assert.equal(upstreamReads, 1, "cache must absorb the second status call");
  assert.equal(credsReads, 1);
});

test("registerQuotaRpc: no credentials or failing upstream degrade to empty groups", async () => {
  const fake = fakeRegister();
  await registerQuotaRpc({
    register: fake.register,
    resolveCreds: async () => null,
    fetchers: STUB_FETCHERS,
  });
  const snap = await fake.handlers.status(
    {},
    { signal: new AbortController().signal },
  );
  assert.deepEqual(snap, { label: "CodeArts", groups: [] });

  const throwing = fakeRegister();
  await registerQuotaRpc({
    register: throwing.register,
    resolveCreds: async () => {
      throw new Error("boom");
    },
    fetchers: STUB_FETCHERS,
  });
  const safe = await throwing.handlers.status(
    {},
    { signal: new AbortController().signal },
  );
  assert.deepEqual(safe, { label: "CodeArts", groups: [] });
});

test("registerQuotaRpc: a host without the rpc domain is a safe no-op", async () => {
  assert.equal(
    await registerQuotaRpc({
      register: undefined,
      resolveCreds: async () => null,
    }),
    false,
  );
});

// ---- statistics/plugin (package quota; CLI-proven AK/SK access) ------------

/** Token-package account (paid subscription): fields the CLI + IDE read. */
function subscriptionResponse() {
  return {
    is_teadmin: false,
    is_white_list: true,
    start_date: "2026-09-17",
    end_date: "2026-11-01",
    show: { metrics: true, package: true },
    package: {
      status: "normal",
      spec_code: "codearts_snap_pro",
      package_name_cn: "专业版",
      package_name_en: "Pro",
      is_token_package: true,
      is_credit_package: false,
    },
    metrics: [
      {
        name: "usageDataChatMessages",
        value: -1,
        usage_token_num: 0,
        package_token_amount: 0,
        show: false,
      },
      {
        name: "usageTokenChatMessages",
        value: 25,
        usage_token_num: 2_500_000,
        package_token_amount: 10_000_000,
        show: true,
      },
      {
        name: "usageTotalPackageCredit",
        package_credit_amount: 5000,
        package_credit_used: 1200,
        package_credit_remain: 3800,
        package_credit_expiring_amount: 300,
        show: true,
      },
      {
        name: "usageBasicPackageCredit",
        package_credit_amount: 0,
        package_credit_used: 0,
        show: true,
      },
    ],
    model_metrics: [],
  };
}

/** Live response shape of a 体验版 CREDIT-package account (2026-10-14):
 * the token metric is a placeholder (amount=1) carrying cumulative usage. */
function trialCreditResponse() {
  return {
    start_date: "2026-09-17",
    end_date: "2026-10-18",
    package: {
      spec_code: "codearts.agent.individual.trial",
      status: "normal",
      package_name_en: "Trial",
      package_name_cn: "体验版",
      is_token_package: false,
      is_credit_package: true,
    },
    show: { metrics: true, package: true },
    is_teadmin: true,
    is_white_list: false,
    metrics: [
      {
        name: "usageDataChatMessages",
        value: -1,
        usage_token_num: 0,
        package_token_amount: 0,
        show: false,
      },
      {
        name: "usageTokenChatMessages",
        value: 0,
        usage_token_num: 9_827_515,
        package_token_amount: 1,
        show: true,
      },
      {
        name: "usageTotalPackageCredit",
        value: 5,
        usage_token_num: 0,
        package_token_amount: 0,
        package_credit_amount: 16588,
        package_credit_used: 841.63,
        package_credit_remain: 15746.37,
        package_credit_expiring_amount: 2158.37,
        show: true,
      },
    ],
    model_metrics: [],
  };
}

test("groupsFromSubscription: token package first, then credits", () => {
  const groups = groupsFromSubscription(subscriptionResponse(), true);
  assert.deepEqual(groups, [
    { title: "套餐额度", bar: "2.5M/10.0M", resetTime: Date.parse("2026-11-01") },
    { title: "通用积分", bar: "1200/5000" },
  ]);
});

test("groupsFromSubscription: english titles + expiry line", () => {
  const groups = groupsFromSubscription(subscriptionResponse(), false);
  assert.deepEqual(
    groups.map((g) => g.title),
    ["Package", "Credits"],
  );
  assert.equal(groups[0].resetTime, Date.parse("2026-11-01"));
});

test("groupsFromSubscription: credit-package account (体验版) has NO token bar", () => {
  // package_token_amount=1 is the placeholder; usage_token_num is cumulative
  // usage — rendering the pair was the "9.8M/1" bug. Credits carry the quota.
  const groups = groupsFromSubscription(trialCreditResponse(), true);
  assert.deepEqual(groups, [
    { title: "通用积分", bar: "842/16.6K", resetTime: Date.parse("2026-10-18") },
  ]);
});

test("groupsFromSubscription: per-metric show:false hides the group", () => {
  const r = trialCreditResponse();
  r.metrics[1].show = false;
  r.metrics[2].show = false;
  assert.deepEqual(groupsFromSubscription(r, true), []);
});

test("groupsFromSubscription: null/empty/malformed yield nothing", () => {
  assert.deepEqual(groupsFromSubscription(null, true), []);
  assert.deepEqual(groupsFromSubscription({}, true), []);
  // zero denominator → no group (avoid a fake 0% bar)
  assert.deepEqual(
    groupsFromSubscription(
      {
        metrics: [
          {
            name: "usageTokenChatMessages",
            usage_token_num: 5,
            package_token_amount: 0,
          },
        ],
      },
      true,
    ),
    [],
  );
  // end_date missing → group without a reset line
  assert.deepEqual(
    groupsFromSubscription(
      {
        metrics: [
          {
            name: "usageTokenChatMessages",
            usage_token_num: 1,
            package_token_amount: 4,
          },
        ],
      },
      true,
    ),
    [{ title: "套餐额度", bar: "1/4" }],
  );
});
