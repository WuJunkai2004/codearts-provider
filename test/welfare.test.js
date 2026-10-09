import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoCheckin,
  claimWelfareCampaign,
  fetchWelfareDelivery,
  localDateString,
} from "../.tsc/utils/welfare.js";

const AK = "TESTAK";
const SK = "TESTSK";
const BASE = "https://welfare.example.com";

const DAILY = {
  campaignId: 1,
  title: "每日签到领1000 积分",
  type: "USER_LOGIN",
  benefitAmount: 1000,
  benefitUnit: "CREDIT",
};

/** Delivery envelope as the gateway returns it. */
function deliveryResponse(items) {
  return Response.json({
    code: 0,
    message: "ok",
    data: { channel: "IDE", items },
  });
}

/** Mock fetch recording calls; handlers are (url-fragment, responder) pairs. */
function mockFetch(handlers) {
  const calls = [];
  const doFetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {}, body: init?.body ?? "" });
    for (const [match, respond] of handlers) {
      if (url.includes(match)) return respond(url, init ?? {});
    }
    throw new Error("unexpected url " + url);
  };
  doFetch.calls = calls;
  return doFetch;
}

function req(fetchImpl) {
  return { ak: AK, sk: SK, base: BASE, fetchImpl };
}

/** checkin 用例：每个用例用独立 AK，避免污染模块级内存守卫（按 AK 分键） */
function reqk(fetchImpl, ak) {
  return { ak, sk: SK, base: BASE, fetchImpl };
}

test("localDateString renders YYYY-MM-DD in local time", () => {
  assert.equal(localDateString(new Date(2026, 9, 9)), "2026-10-09");
  assert.equal(localDateString(new Date(2026, 0, 2)), "2026-01-02");
});

test("fetchWelfareDelivery unwraps the {code,message,data:{items}} envelope", async () => {
  const doFetch = mockFetch([
    [
      "/v1/ops/delivery",
      () =>
        deliveryResponse([
          DAILY,
          {
            ...DAILY,
            campaignId: 2,
            type: "INVITE_USER",
            status: null,
            claimable: false,
          },
        ]),
    ],
  ]);
  const campaigns = await fetchWelfareDelivery(req(doFetch));
  assert.equal(campaigns.length, 2);
  assert.equal(campaigns[0].campaignId, 1);
  assert.equal(campaigns[0].type, "USER_LOGIN");
  assert.equal(campaigns[1].status, null);
  // welfare headers mirror the IDE: Agent-Type PromptCenter
  assert.equal(doFetch.calls[0].init.headers["Agent-Type"], "PromptCenter");
  assert.ok(doFetch.calls[0].url.endsWith("/v1/ops/delivery?channel=IDE"));
});

test("fetchWelfareDelivery throws on a non-zero envelope code", async () => {
  const doFetch = mockFetch([
    [
      "/v1/ops/delivery",
      () => Response.json({ code: 403, message: "forbidden" }),
    ],
  ]);
  await assert.rejects(() => fetchWelfareDelivery(req(doFetch)), /forbidden/);
});

test("claimWelfareCampaign: claim then confirm, IDE body shape", async () => {
  const doFetch = mockFetch([
    [
      "/v1/ops/claim",
      () =>
        Response.json({
          code: 0,
          message: "ok",
          data: {
            campaignId: 1,
            campaignTitle: DAILY.title,
            status: "CLAIMED",
            totalAmount: 1000,
          },
        }),
    ],
    [
      "/v1/ops/confirm",
      () =>
        Response.json({
          code: 0,
          message: "ok",
          data: {
            status: "CONFIRMED",
            totalAmount: 7000,
            remainingAmount: 6173.51,
          },
        }),
    ],
  ]);
  const out = await claimWelfareCampaign(req(doFetch), 1);
  assert.equal(out.status, "CONFIRMED", "fresh claim is confirmed");
  assert.equal(out.amount, 1000);
  const claim = JSON.parse(doFetch.calls[0].body);
  assert.equal(claim.campaignId, 1);
  assert.equal(claim.channel, "IDE");
  assert.match(claim.idempotentKey, /^claim_1_\d+$/);
  assert.ok(doFetch.calls[1].url.includes("/v1/ops/confirm"));
  assert.deepEqual(JSON.parse(doFetch.calls[1].body), { campaignId: 1 });
});

test("claimWelfareCampaign: already-claimed status is idempotent, no confirm", async () => {
  const doFetch = mockFetch([
    [
      "/v1/ops/claim",
      () =>
        Response.json({
          code: 0,
          message: "ok",
          data: { campaignId: 1, status: "CONFIRMED" },
        }),
    ],
  ]);
  const out = await claimWelfareCampaign(req(doFetch), 1);
  assert.equal(out.status, "CONFIRMED");
  assert.equal(doFetch.calls.length, 1, "confirm not re-sent");
});

test("claimWelfareCampaign: claim failure propagates the envelope error", async () => {
  const doFetch = mockFetch([
    [
      "/v1/ops/claim",
      () => Response.json({ code: 1301, message: "campaign not started" }),
    ],
  ]);
  await assert.rejects(
    () => claimWelfareCampaign(req(doFetch), 1),
    /not started/,
  );
});

const CLAIM_HANDLERS = () => [
  [
    "/v1/ops/delivery",
    () => deliveryResponse([{ ...DAILY, status: "ELIGIBLE", claimable: true }]),
  ],
  [
    "/v1/ops/claim",
    () =>
      Response.json({
        code: 0,
        data: { campaignId: 1, status: "CLAIMED", totalAmount: 1000 },
      }),
  ],
  [
    "/v1/ops/confirm",
    () => Response.json({ code: 0, data: { status: "CONFIRMED" } }),
  ],
];

test("autoCheckin: claims when the server says ELIGIBLE, then same-day runs skip", async () => {
  const doFetch = mockFetch(CLAIM_HANDLERS());
  const out = await autoCheckin(reqk(doFetch, "CK-CLAIM"));
  assert.equal(out.result, "claimed");
  assert.match(out.detail, /#1 .*CONFIRMED \+1000 CREDIT/);
  assert.equal(doFetch.calls.length, 3, "delivery + claim + confirm");

  // second run the same day: in-memory day guard, zero extra calls
  const before = doFetch.calls.length;
  assert.equal(await autoCheckin(reqk(doFetch, "CK-CLAIM")), null);
  assert.equal(doFetch.calls.length, before);
});

test("autoCheckin: server-reported claimed state needs no claim (idempotent)", async () => {
  const doFetch = mockFetch([
    [
      "/v1/ops/delivery",
      () =>
        deliveryResponse([{ ...DAILY, status: "CONFIRMED", claimable: false }]),
    ],
  ]);
  const out = await autoCheckin(reqk(doFetch, "CK-ALREADY"));
  assert.equal(out.result, "already");
  assert.equal(doFetch.calls.length, 1, "delivery only — the server is the truth");
  assert.equal(await autoCheckin(reqk(doFetch, "CK-ALREADY")), null, "guarded after");
});

test("autoCheckin: per-AK guard — another account still probes", async () => {
  const doFetch = mockFetch(CLAIM_HANDLERS());
  await autoCheckin(reqk(doFetch, "CK-A1"));
  const before = doFetch.calls.length;
  const out = await autoCheckin(reqk(doFetch, "CK-A2"));
  assert.equal(out.result, "claimed");
  assert.ok(doFetch.calls.length > before, "other AK re-probes");
});

test("autoCheckin: failure backs off, then probes again after the window", async () => {
  const t0 = new Date(2026, 9, 9, 8, 0, 0);
  let healthy = false;
  const doFetch = mockFetch([
    [
      "/v1/ops/delivery",
      () =>
        healthy
          ? deliveryResponse([{ ...DAILY, status: "ELIGIBLE", claimable: true }])
          : Promise.reject(new Error("boom")),
    ],
    ...CLAIM_HANDLERS().slice(1),
  ]);

  const failed = await autoCheckin(reqk(doFetch, "CK-BACKOFF"), t0);
  assert.equal(failed.result, "failed");
  assert.match(failed.detail, /boom/);

  // within the 10-min backoff: skipped without touching the network
  const before = doFetch.calls.length;
  assert.equal(
    await autoCheckin(reqk(doFetch, "CK-BACKOFF"), new Date(t0.getTime() + 60_000)),
    null,
  );
  assert.equal(doFetch.calls.length, before, "no call during backoff");

  // past the window: probes again and recovers
  healthy = true;
  const retry = await autoCheckin(
    reqk(doFetch, "CK-BACKOFF"),
    new Date(t0.getTime() + 11 * 60_000),
  );
  assert.equal(retry.result, "claimed");
});

test("autoCheckin: day change re-arms the guard (probes the new day)", async () => {
  const day1 = new Date(2026, 9, 9, 23, 59, 0);
  const day2 = new Date(2026, 9, 10, 0, 1, 0);
  const doFetch = mockFetch(CLAIM_HANDLERS());
  await autoCheckin(reqk(doFetch, "CK-DAY"), day1);
  const before = doFetch.calls.length;
  const out = await autoCheckin(reqk(doFetch, "CK-DAY"), day2);
  assert.equal(out.result, "claimed");
  assert.ok(doFetch.calls.length > before, "new day probes again");
});
