# AGENTS.md

OpenCode provider plugin for Huawei Cloud CodeArts (snap-access InferHub), signed with APIG `SDK-HMAC-SHA256`. Small TypeScript ESM package. **This file is the authoritative spec for agents** (gateway routing rules, signing algorithm, endpoint list, architecture, build/test workflow) — read it before touching `src/`. README.md keeps human-facing usage only.

## Commands

```bash
npm install
npm run build        # tsc --noEmit + esbuild -> dist/index.js (the ONLY dist file; REQUIRED before plugin use)
npm run typecheck    # tsc --noEmit
npm test             # node --test "test/*.test.js" (pretest emits .tsc/ and rebuilds the bundle)
```

- Tests import scattered modules from `../.tsc/*` (tsc emit, gitignored) and the real published artifact from `../dist/index.js` (esbuild bundle). `pretest` runs both builds, so `npm test` is self-sufficient; a bare `node --test` needs `npm run build` first.
- `test/live-check.js` is a real-API smoke test, NOT run by `npm test` (glob only matches `*.test.js`). It needs `CODEARTS_CLI_AK`/`CODEARTS_CLI_SK` env vars and a fresh build: `node test/live-check.js`. Besides the welfare smoke it probes the two quota RPC data sources: snap-access `statistics/plugin` with the CLI's exact shape (AK/SK + `Agent-Type: PromptCenter`; expected to work) and opengw `tokens/balance` (`{error_code:"0000", result}`; run once to confirm the shape the quota RPC parses).
- Run a single test: `node --test --test-name-pattern "<pattern>" test/plugin.test.js`.
- On Windows Git Bash, use `npm.cmd` if bare `npm` is not found.
- Commits follow Conventional Commits in English (`fix:`, `feat:`, `refactor(scope):`, `docs:`); no CI, tags, or release flow exist.

## Architecture

- `src/index.ts` — thin dual-format entry, default export `{ id, server, setup }` (docs.build/plugins/migrate-v1 "Support V1 and V2 from one package"): V1 hosts call `server()`, V2 hosts call `setup(ctx)`. The V2 host validates `id` + `setup` and ignores unknown fields.
- `src/v1/index.ts` — the V1 `server()`: hooks `config` (register provider + inject signed fetch + fire-and-forget daily welfare auto check-in), `provider` (dynamic model refresh), `auth` (`/connect` two-step AK/SK flow: step 1 = AK via custom prompt, step 2 = SK via built-in API key page; stored as `key` = SK, `metadata.ak` = AK; `autoCheckin: false` disables the welfare check-in — the check-in is deliberately NOT an LLM tool). There is NO `tool` hook: the gateway's main chat models take image parts natively (`supports_images`), so the old external vision-model helper (`codearts_vision` → the now-unregistered `Qwen3-VL-235B`) was removed.
- `src/v2/index.ts` + `src/v2/types.ts` — the V2 `setup(ctx)`, mapping V1 hooks onto V2 domains per migrate-v1 + docs/build/plugins/effect: `config` → `ctx.provider.transform` (`editor.add({ info, models })` with `Provider.Info` fields `activation`/`package`/`settings`; falls back to `update` + `models.set`), `auth` → `ctx.integration.transform` (key method + AK form field), and V1 `options.fetch` → `ctx.session.hook("http.request", …, { providerID })` via `signNativeRequest`, plus a V2-only retry-policy hook (`"retry"`, no V1 equivalent — see the protocol-quirks bullet). The `session.hook` contract in `types.ts` uses per-name overloads so each hook event keeps its own type. Domains are optional in the context type — a host without a domain skips that part instead of failing the plugin. No `@opencode-ai/*` runtime import in the V2 path. (The former `tool` → `ctx.tool.transform` mapping is gone with the vision tool; the optional `tool` domain type remains in `types.ts` as part of the documented host contract.)
- **V2 provider `settings` must stay JSON-safe** — the registry structured-clones definitions, so a function (e.g. an injected fetch) kills the whole transform with `DataCloneError` and the plugin is disabled ("看不到模型" was exactly this). Signing therefore happens on the wire in the `http.request` hook; request-time credentials come from `ctx.integration.connection.active/resolve` (same `key` = SK / `metadata.ak` = AK layout), resolved lazily per request. Models use the V2 `Model.Info` shape (`toModelInfo`: `modelID`, `capabilities.input` modality array, `cost` tier array, `enabled`, `time`); a 60s interval re-runs discovery and calls `ctx.provider.reload()` when the inventory changes. `setup` returns a cleanup that clears the interval.
- `src/utils/` — host-neutral logic shared by both entries: `models.ts` (`fetchModels` + fallbacks, `toModel`/`toConfigModel`/`toModelInfo` — thinking strengths map to V2 variants), `credentials.ts` (AK/SK resolution, `/connect` storage parsing, `resolveBase`), `constants.ts` (ids), plus the API modules (`signer.ts`, `discover.ts`, `cache.ts`, `i18n.ts`, `opengw.ts`).
- ~~`src/utils/vision.ts`~~ — REMOVED (2026-11): the `codearts_vision` tool called a fixed external vision model (`Qwen3-VL-235B`, routing alias) to describe images for non-vision chat models. That alias no longer exists in the gateway inventory, and the main chat models now carry `supports_images: true` (glm-5.3-flash / deepseek-v4.1-flash / kimi-k3 family) and accept `image_url` message parts natively — image passthrough needs no helper. `paths.ts` (image-path resolution) went with it.
- `src/utils/welfare.ts` — welfare (权益/签到) API + the daily auto check-in. There is deliberately NO LLM tool for welfare: claiming is a deterministic account mutation and must not be triggered probabilistically by a model — the auto check-in covers the daily case, and one-time campaigns (student certification / invite) are queried via `test/live-check.js` instead. API: `fetchWelfareDelivery` (campaign list), `claimWelfareCampaign` (claim → auto-confirm, mirroring the IDE flow), `autoCheckin` (server-state driven: the delivery endpoint is the "already claimed today" truth — NO local state file; a per-AK in-memory day-guard keeps the periodic probe to one delivery GET per account per local day, failures back off 10 min instead of retrying every cycle). Auto check-in targets the `USER_LOGIN` campaign (`claimable || status === "ELIGIBLE"`); the module-level `autoCheckin(req, now?)` serves both entries: V1 fires it in the `config` hook (fire-and-forget, tests never invoke it), V2 rides the 60s `refresh()` cycle (cleanup clears the timer); `autoCheckin: false` disables it. Welfare requests are PLAIN signed calls — no CLI chat shape, no session slot — with the IDE's headers (`Agent-Type: PromptCenter`, empty `x-auth-token`, `X-Language`). All functions take `fetchImpl` for tests; `autoCheckin` takes an injectable clock.
- `src/utils/signer.ts` — SDK-HMAC-SHA256 signing + two wrappers over it: `createSignedFetch` (V1 `options.fetch`) and `signNativeRequest` (V2 `http.request`: Request → shaped, signed Request; session id = the host's real session). Shared helpers: `applyCliBodyShape`, `cliChatHeaders`, `collectHeaders`/`mergeHeaders` (case-insensitive dedupe, `authorization` stripped). Signs every request including streaming bodies (body SHA256 must be computed after serialization).
- `src/utils/discover.ts` — `discoverModels` orchestrates three sources: `discoverAgentCenter` (primary, fail-fast: `useragents` → `pickAgentId` → `detail`, requires `Agent-Type: AgentCenter`), `discoverOpengw` (best-effort supplement, deduped by model id — errors only logged) and `fetchThinkingVariants` (best-effort gears: `POST /v1/model/thinking-variants`). Returns `[]` when the account has no enabled models (no hardcoded fallback).
- `src/utils/cache.ts` — model-list file cache at `~/.local/share/opencode/codearts-models.json` (`{ base, fetchedAt, models }`, keyed by base URL; malformed/missing/mismatched-base all read as a miss). Writes are best-effort.
- `src/utils/models.ts` — there are **no hardcoded models** (`EXTRA_MODELS` and `FALLBACK_MODELS` are gone). `fetchModels()` writes the cache on success and falls back on failure: in-memory `lastGoodModels` → file cache → `null`, where `null` makes the caller emit the `connect-required` hint model. `resolveBase()` (`src/utils/credentials.ts`) strips a trailing `/api/v2`, so `baseURL` may be passed with or without it.
- `src/utils/quota-panel.ts` — quota RPC for the opencode-glm-vistatus sidebar: registers `codearts.quota` with a `status` method over the host plugin-RPC channel (host contract `ctx.rpc.register`, ≥ v2.0.25; the promise adapter wires it into the core RPC service, which the server exposes at `POST /api/rpc/<id>/<method>`). Output is the cross-plugin contract `{ label, groups: [{ title, bar, resetTime? }] }` — `bar` follows the reader's string contract (`nn%`/`xx/yy`), `title` is display-ready (THIS side owns i18n) and `resetTime` is raw Unix epoch MILLISECONDS (the reader renders the countdown + clock line itself; the expiry line reads the TOP-LEVEL `end_date` and `Date.parse`s it — `package.end_date` does not exist in the real payload). `registerQuotaRpc` is fired once at V2 setup (pull-based — no timer of its own; credentials re-resolve per cache miss, so rotations are picked up automatically; a host without the rpc domain is a safe no-op; a 4-min result cache absorbs the panel's 30s polling — the CLI itself polls statistics every 10). Two AK/SK data sources, fetched in parallel (wire facts in `REVERSE-ENGINEERING-CLI.md`): **snap-access `GET /snap-manager/v1/statistics/plugin`** — the package quota, signed with `Content-Type` + `Agent-Type: PromptCenter` exactly like the official CLI's 10-min subscription poll (the IDE instead uses its `x-auth-token`; AK/SK acceptance is CLI-proven) → groups 套餐额度 (`usageTokenChatMessages`: `usage_token_num`/`package_token_amount`) and 通用积分 (`usageTotalPackageCredit`: `package_credit_used`/`package_credit_amount`) — but ONLY for token-package accounts: a **credit-package account (体验版, `package.is_token_package: false`) returns the PLACEHOLDER `package_token_amount = 1` with cumulative cycle usage in `usage_token_num` (live-verified 2026-10-14, the "9.8M/1" bug) — no token bar is rendered and the credits group carries the quota**; the expiry line reads the TOP-LEVEL `end_date` (package cycle — `package.end_date` does not exist in the real payload), and a metric's own `show: false` flag hides it; **opengw `GET /api/v1/user/tokens/balance`** — envelope `{error_code:"0000", result}`, groups 权益额度 (`total_quota`/`used_amount`) and 教育额度 (`monthly_token_limit`/`monthly_tokens_used`) as rendered by the IDE webview. All bars are compact `xx/yy` (`K/M` suffixes; the reader derives the percentage). `fetchQuotaSnapshot` is best-effort: a failing source contributes no groups, total failure yields an empty list, and the panel falls back to its GLM view. The pure mapping + RPC behaviors (cache, no-creds degradation, missing-domain no-op) are regression-checked in `test/quota-panel.test.js`.
- `src/utils/i18n.ts` — zh/en strings, language from `CODEARTS_LANG` > `LC_ALL` > `LANG`.
- `src/utils/opengw.ts` — runtime registry for opengw-discovered models (`syncOpengwModels` + `isOpengwModel`). Single writer is `models.ts` (every `fetchModels` path, including the no-creds and cache-fallback paths); single reader is `cliChatHeaders`. Discovered models carry `opengw: true` as plain data — never mutate the registry from discovery code.
- `src/utils/constants.ts` + `src/utils/credentials.ts` — provider ids, AK/SK credential resolution and `/connect` storage parsing.
- `dist/` holds ONLY the single-file esbuild bundle `dist/index.js` — the loaded artifact and the only published file (`npm pack` = 3 files: this, README, package.json; zero declared deps). The bundle has NO runtime imports at all (`@opencode-ai/plugin` and zod are type-only and erased since the vision tool — the last `tool()`/zod user — was removed). tsc emits to `.tsc/` (gitignored, never published) purely for the tests. `src/` is never imported at runtime.

## Critical protocol quirks (easy to break, hard to debug)

- **Model ID = `model_alias` (lowercase routing alias), display name = `model_name`.** Requesting by `model_name` fails with `InferHub.002002009 not registered`.
- **Canonical URI requires a trailing slash in the signature** (`/v1/sessions` signs as `/v1/sessions/`) while the actual request path is unchanged. Missing this → 401.
- **The OpenAI SDK's `Authorization: Bearer` header must be removed/replaced** by the Huawei signature header, or the gateway reports `APIG.0301 decrypt token fail`.
- **`signNativeRequest` must drop the original `content-length`** before building the replacement Request: the CLI body shaping grows the body, and a stale length makes the gateway hash a truncated body → 401 signature failure (indistinguishable from bad AK/SK at the error level).
- **Headers are case-insensitively deduped before signing**: `user-agent` + `User-Agent` coexisting sends two headers but signs one → `APIG.0301 verify ak sk signature fail`.
- **Chat requests must mimic the CLI's exact request shape** (User-Agent `ai-sdk/provider-utils/4.0.21 runtime/bun/1.3.14`, full `x-ot-*` header set, body fields `stream: true` / `tool_stream` / `user_prompt`). The gateway routes by request shape; any missing piece lands on the wrong backend (Whitelabel 404 / not registered). Discovery endpoints do NOT need this shape.
- **Strip host-injected max-token fields from the chat body** (`applyCliBodyShape` deletes `max_completion_tokens` / `max_tokens`): opencode v2.0.25 started sending `max_completion_tokens: <limit.output>`, and InferHub rejects BOTH fields with `InferHub.001001005.400 The request param is invalid` on (most) LB backend nodes — wrapped as a fake `data:{"text":"[DONE]",error_code:...}` SSE line, surfacing as "OpenAI Chat stream ended without finish_reason". Renaming to `max_tokens` does NOT help; the CLI simply never sends any max-token field. `store` / `stream_options` are tolerated.
- **Normalize the gateway's pseudo-SSE error wrapping into a real non-2xx error** (`utils/sse.ts` `guardChatResponse`, wired into V1 `createSignedFetch` and the V2 `http.response` hook): EVERY pre-model failure — rate limit `InferHub.ModelArts.81114.429`, not-registered `InferHub.002002009.404` (either a model still in staged rollout — kimi-k3.1-pro on 2026-10-30 was unregistered on the LB for hours after appearing in agent-center discovery, self-healed once registration completed — or requesting by display name instead of `model_alias`), invalid params `001001005.400` — arrives as HTTP 200 + `text/event-stream` with a single error line, which the OpenAI SDK misreports as "stream ended without finish_reason". The guard peeks the first SSE event; on `error_code` it cancels the body and returns plain JSON `{error:{message, code}}` with the status embedded in the code's last segment (429/404/…, else 502); healthy streams replay byte-identical (first line may be split across TCP chunks, so peeked bytes are re-queued). **No retry in the guard itself — the guard only fixes protocol shape**: a true 429 lets opencode's native backoff work. Retry POLICY is a separate, V2-only plugin hook (`ctx.session.hook("retry", …)` in `src/v2/index.ts`; no V1 equivalent): the host classifies provider failures BEFORE the hook runs, and the moderation family lands on terminal classes (403 → `AuthenticationError`, 400 → `InvalidRequestError`) — but the wrapped `InferHub.ModelArts.81xxx` rejections are a KNOWN-FLAKY backend content-moderation family in practice (`81011.403` text-refusal misfires, `81001.400` "the content of image_url.url field is unsafe" image misfires, 2026-11-07: retry usually succeeds), so the hook upgrades exactly `isInferHubModerationError(message)` (guard-produced `CodeArts InferHub error InferHub.ModelArts.81\d{3}.` prefix in `utils/sse.ts`) to `{ retry: true, delay: 2000 }` — flat 2s replaces the host's exponential backoff because moderation misfires don't need growing waits. A proposed retry (rate limits — `81114.429` is pattern-adjacent but arrives retryable) keeps its own delay via the hook's early return; gateway-level failures (APIG signatures) and deterministic rejections (`001001005.400` invalid params, `002002009.404` not registered, `TM.*` session slots) never match and stay terminal; the host's built-in 10-attempt cap still bounds forced retries. opencode's classifier is English-only: the Chinese moderation refusal text does NOT match its `CONTENT_POLICY_TEXT`, hence the plugin-side predicate (unit-tested in `test/sse.test.js`, hook behavior in `test/plugin.test.js` "V2 retry hook"). The retry LOOP itself is entirely the host's — the plugin only flips the decision, it implements no retry scheduling. kimi-k3/kimi-k3.1-pro verified 2026-10-30: their streaming format is fully standard (`choices[].delta`, `finish_reason:"stop"`, `data:[DONE]`) — there never was a kimi-specific format problem.
- `user-session-id` is per-`createSignedFetch`-instance and counts against a 3-concurrent-session server limit (slots are released only ~60-75s after use; exceeding → `TM.00001041 并发会话数已达上限`); keep it stable per process. `createSignedFetch(ak, sk, { sessionId })` lets a caller pin one (no in-plugin user remains — the vision tool that used it is gone — but the option stays for hosts that need slot isolation).
- **Pasted images now flow through natively.** The main chat models advertise `supports_images: true` and the gateway accepts `image_url` message parts on them, so opencode's `FilePart`s become regular OpenAI image content and pass through the chat body untouched. `applyCliBodyShape` echoes the JOINED TEXT PARTS of an array-content user message as `user_prompt` (never the raw array, never an empty string — an empty echo is a request shape the CLI never sends).
- **Thinking gears (思考挡位) come from their OWN endpoint: `POST /v1/model/thinking-variants`** (`Agent-Type: PromptCenter`, plain signed call, body `{ model_names: [...] }` capped at 50 names, response `{ variants: { <model_alias>: { strengths: ["low","high","max"], default_strength } } }`). This is what the official CLI's `thinking-variants-service` calls (its `XCENTER_BASE_URLS` falls back to the InferHub base); the agent-center detail's `supported_thinking_strengths` field is EMPTY in practice — do not treat it as the gear source (2026-11-25 mistake, live-verified). `discover.ts` `fetchThinkingVariants` maps strengths per model id into `DiscoveredModel.thinkingLevels` (best-effort: failure costs only the gears) and flips `reasoning: true` for models that have any; `toModelInfo` renders each level as a V2 variant `{ id, body: { reasoning_effort: level } }` — selecting a gear injects a TOP-LEVEL `reasoning_effort` into the request body, the same field the official CLI's variants (`{low: {reasoningEffort: "low"}, …}`) produce. `default_strength` is NOT consumed — the official CLI ignores it too ("Default" in its picker is the base model without a variant). Current gateway truth (2026-11-25): low/high/max on deepseek-v4.1-flash-1017 / glm-5.3-flash / deepseek-v4.1-flash / glm-5.3 / kimi-k3.1-pro / kimi-k3; high/max on GLM-5.2 / glm-5.2-sft-harmony; none on openpangu-2.x / speed.

## Credential priority

`provider options` > `plugin options` > env `CODEARTS_CLI_AK`/`CODEARTS_CLI_SK` > `/connect` connection (V2: `ctx.integration.connection`) > `/connect` stored auth (`auth.json`). With no credentials the provider still registers with a single placeholder model `connect-required` and makes no inference calls.

## V2 entry resolution (opencode 2.x loader)

- A **directory** target resolves its server entry by trying `<dir>/server.*` then `<dir>/index.*` (Bun resolution); a **file** target is the entry; an npm package uses `exports["./server"]` (fallback `main`). The TUI/CLI (`cli.json`) resolves the **`tui.*` entry** instead — a server plugin registered in `cli.json` is never loaded by the server; register server plugins under `plugins` in `opencode.json(c)`.
- The loaded module's default export must carry `id` + `setup` (or `effect`); anything else is rejected with "Plugin must export a default definition with an id and an effect or setup function."

## Gateway protocol (full spec)

The snap-access gateway **routes by request shape**; a chat request missing any piece lands on the wrong backend (Whitelabel 404 / `not registered`). Discovery endpoints do NOT need this shape.

1. **User-Agent must be the CLI's**: `ai-sdk/provider-utils/4.0.21 runtime/bun/1.3.14` (Node's default UA → Whitelabel 404). The SDK sends a lowercase `user-agent` which coexists with an injected `User-Agent` as two JS-object keys — two headers go on the wire but only one gets signed → `APIG.0301 verify ak sk signature fail`. The signer merges chat headers case-insensitively (latter wins).
2. **Full CLI header set**: `x-ot-trace-id` / `x-ot-span-id` / `x-snap-traceid` (`32hex_16hex`) / `x-ot-session-id` / `x-ot-parent-session-id` (empty) / `user-session-id` / `x-ot-function: agent-tui` / `X-Language` / `user-msg-id` / `created-time` / `x-ot-client-type: CLI` / `x-ot-client-version` / `client-ip` / `X-Security-token` (empty) / `model-id` / `model-name` (both the routing alias).
3. **Body fields**: `stream: true`, `tool_stream: true`, `user_prompt` (text of the last user message).

Session notes:

- `/v1/sessions` registration needs `Agent-Type: PromptCenter` (AgentCenter/CodeBase → `TM.00001001`); the CLI POSTs it at startup with a 120s heartbeat. This plugin does NOT use it — chat works directly.
- One opencode process (including `/new` conversations) shares a single session slot: the plugin generates `user-session-id` once per `createSignedFetch` instance.

### Endpoints

| Endpoint                                       | Use                                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v2/chat/completions`                | Chat (OpenAI-compatible, SSE streaming; requires CLI shape)                                                                |
| `GET /v1/agent-center/agents/useragents`       | Agent list (requires `Agent-Type: AgentCenter`)                                                                            |
| `GET /v1/agent-center/agents/detail?agent_id=` | Agent detail incl. model list (`model_alias` = routing id)                                                                 |
| `POST /v1/sessions`                            | Session registration (requires `Agent-Type: PromptCenter`; unused by this plugin; 3-concurrent limit by `user-session-id`) |
| `GET /v1/ops/delivery?channel=IDE`             | Welfare campaign list + claim status (`Agent-Type: PromptCenter`; envelope `{code, message, data:{items}}`)                |
| `POST /v1/ops/claim`                           | Claim a campaign: `{campaignId, idempotentKey: "claim_<id>_<ms>", channel: "IDE"}` → `{data:{campaignId, status}}`         |
| `POST /v1/ops/confirm`                         | Confirm after claim: `{campaignId}` → `status: CONFIRMED` + credit-bucket totals (`remainingAmount` 通用积分)              |
| `POST /v1/model/thinking-variants`             | Thinking gears (`{model_names:[...]}` ≤50; `Agent-Type: PromptCenter`; → `{variants:{<alias>:{strengths,default_strength}}}`) |
| `GET /snap-manager/v1/statistics/plugin`       | Package quota (tokens + credits; AK/SK + `Agent-Type: PromptCenter`, CLI-proven; the IDE uses `x-auth-token`)              |
| `GET opengw/api/v1/user/tokens/balance`        | Benefit-token balance (`{error_code:"0000", result}`; benefit + education pools; no caller inside the official CLI)        |

`Agent-Type: AgentCenter` is required on discovery endpoints: missing → "请求头Agent-Type为空", wrong value → TM.00001001. Welfare ops endpoints instead send `Agent-Type: PromptCenter` (plus an empty `x-auth-token`), mirroring the IDE; the campaign `status` lifecycle is `ELIGIBLE → CLAIMED → CONFIRMED → CONSUMED` (`null` = event-driven, e.g. INVITE_USER). The daily check-in is campaign type `USER_LOGIN` ("每日签到领1000 积分"); these credits fund the `maas_type: benefit` models.

## Python reference implementation

Complete Python description of every algorithm needed to call CodeArts InferHub directly. What the plugin does is equivalent to: for every outbound HTTP request, compute the Huawei APIG `SDK-HMAC-SHA256` signature headers and replace the SDK's `Authorization`; chat requests additionally need the CLI shape above.

### 1. Signing (SDK-HMAC-SHA256)

```python
import datetime, hashlib, hmac, urllib.parse

def sdk_date():
    # UTC 时间戳，格式 20260909T123456Z
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")

def rfc3986(s):
    # URI 编码（保留 -_.~），与 JS 端 encodeURIComponent 行为一致
    return urllib.parse.quote(str(s), safe="-_.~")

def sign_request(method, url, ak, sk, headers=None, body=b""):
    """计算华为云 APIG SDK-HMAC-SHA256 签名，返回需附加的请求头。"""
    u = urllib.parse.urlparse(url)
    headers = dict(headers or {})

    # --- CanonicalQuery：query 参数按 key 排序，key/value 均 RFC3986 编码 ---
    q = sorted(
        (rfc3986(k), rfc3986(v))
        for k, v in urllib.parse.parse_qsl(u.query, keep_blank_values=True)
    )
    canonical_query = "&".join(f"{k}={v}" for k, v in q)

    # --- CanonicalURI：路径解码后，末尾必须补斜杠（华为云特有规则！）---
    #   /api/v2/chat/completions  ->  /api/v2/chat/completions/
    canonical_path = urllib.parse.unquote(u.path) or "/"
    if not canonical_path.endswith("/"):
        canonical_path += "/"

    # --- CanonicalHeaders：参与签名的头（小写）+ host + x-sdk-date ---
    h = {k.lower(): str(v).strip() for k, v in headers.items()}
    h["host"] = u.netloc
    h["x-sdk-date"] = sdk_date()
    names = sorted(h)                                     # 头名按字典序
    canonical_headers = "".join(f"{n}:{h[n]}\n" for n in names)
    signed_headers = ";".join(names)

    # --- CanonicalRequest ---
    payload = body if isinstance(body, bytes) else body.encode()
    canonical_request = "\n".join([
        method.upper(),                                   # 1. HTTP 方法
        canonical_path,                                   # 2. 规范化 URI（带尾斜杠）
        canonical_query,                                  # 3. 规范化 query
        canonical_headers,                                # 4. 规范化头（每行以 \n 结尾）
        signed_headers,                                   # 5. 参与签名的头名列表
        hashlib.sha256(payload).hexdigest(),              # 6. 请求体 SHA256（十六进制）
    ])

    # --- StringToSign ---
    string_to_sign = "\n".join([
        "SDK-HMAC-SHA256",                                # 固定算法名
        h["x-sdk-date"],                                  # 时间戳
        hashlib.sha256(canonical_request.encode()).hexdigest(),
    ])

    # --- Signature：HMAC-SHA256(SK, StringToSign) ---
    signature = hmac.new(sk.encode(), string_to_sign.encode(), hashlib.sha256).hexdigest()

    return {
        **headers,
        "X-Sdk-Date": h["x-sdk-date"],
        "Authorization": (
            f"SDK-HMAC-SHA256 Access={ak}, "
            f"SignedHeaders={signed_headers}, "
            f"Signature={signature}"
        ),
    }
```

Key points (all also apply to the TS signer):

- **Trailing-slash rule**: `/v1/sessions` signs as `/v1/sessions/` while the actual request path is unchanged. Missing this → 401.
- **Body hash**: the signature covers the body, so serialization must finish before signing (streaming requests included; SSE responses are unaffected).
- **Authorization replacement**: the OpenAI-compatible SDK sends `Authorization: Bearer <apiKey>`; after signing, this header must be **removed** so only the Huawei signature header remains, or the gateway parses it as an IAM token → `APIG.0301 decrypt token fail`.
- **Header case dedupe**: if both `user-agent` and `User-Agent` exist as keys, the HTTP layer sends two headers but the signature covers one → verification fails. Normalize case-insensitively before sending.

### 2. Sending a signed request

```python
import json, urllib.request, urllib.error

def request(method, url, body=None, headers=None, ak=AK, sk=SK, timeout=180):
    headers = dict(headers or {})
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        headers.setdefault("Content-Type", "application/json")
    # 对完整请求（含 body）计算签名
    signed = sign_request(method, url, ak, sk, headers, data or b"")
    req = urllib.request.Request(url, data=data, method=method.upper(), headers=signed)
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} {url}: {e.read().decode('utf-8', 'replace')[:400]}") from e
```

发现类接口（agent-center）用普通 User-Agent 即可；**chat 接口必须用下面的 CLI 头集**。

### 3. Model discovery (agent-center chain)

```python
import json, uuid

BASE = "https://snap-access.cn-north-4.myhuaweicloud.com"

# 步骤 1：列出账号可用 agent（CLI 客户端找 supported_clients 含 CLI 的，
#          找不到则退回 CodeAgent / is_primary_agent / 第一个）
r = request("GET", BASE + "/v1/agent-center/agents/useragents?offset=0&limit=100",
            None, {"X-Language": "zh-cn", "Agent-Type": "AgentCenter"})
agents = json.loads(r.read())["agents"]
agent_id = next(a["agent_id"] for a in agents
                if "CLI" in (a.get("supported_clients") or []))

# 步骤 2：拉取 agent 详情，gpts.models 即模型清单
r = request("GET", BASE + f"/v1/agent-center/agents/detail?agent_id={agent_id}",
            None, {"X-Language": "zh-cn", "Agent-Type": "AgentCenter"})
detail = json.loads(r.read())

for m in detail["gpts"]["models"]:
    p = m.get("model_parameters") or {}
    print(m["model_alias"],                     # 路由 ID（请求体 model 字段用这个！）
          m["model_name"],                      # 显示名
          p.get("context_window"),              # 上下文窗口
          p.get("max_tokens"),                  # 最大输出
          p.get("supports_images"),             # 多模态
          p.get("thinking_type"))               # 推理能力标记
```

### 4. Chat (streaming; CLI shape mandatory)

```python
import datetime

SESSION_ID = "ses_" + uuid.uuid4().hex[:26]     # 一个会话内保持不变

def cli_headers(model):
    """chat 请求必需的完整 CLI 头集（网关按形态路由）。"""
    return {
        "User-Agent": "ai-sdk/provider-utils/4.0.21 runtime/bun/1.3.14",
        "X-Security-token": "",
        "x-ot-trace-id": uuid.uuid4().hex,
        "x-ot-span-id": uuid.uuid4().hex,
        "x-snap-traceid": f"{uuid.uuid4().hex}_{uuid.uuid4().hex[:16]}",
        "x-ot-session-id": SESSION_ID,
        "x-ot-parent-session-id": "",
        "user-session-id": SESSION_ID,
        "x-ot-function": "agent-tui",
        "X-Language": "zh-cn",
        "user-msg-id": "msg_" + uuid.uuid4().hex[:24],
        "created-time": datetime.datetime.now(datetime.timezone.utc)
                        .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "x-ot-client-type": "CLI",
        "x-ot-client-version": "26.8.12",
        "client-ip": "198.18.0.1",              # CLI 发送本机出口 IP
        "model-id": model,                       # 路由别名，不是显示名
        "model-name": model,
    }

def chat(model, messages, stream=True):
    body = {
        "model": model,                          # 路由别名（model_alias）
        "messages": messages,
        "stream": True,                          # 必须为 true
        "tool_stream": True,
        "user_prompt": next((m["content"] for m in reversed(messages)
                             if m["role"] == "user"), ""),
    }
    r = request("POST", BASE + "/api/v2/chat/completions", body, cli_headers(model))
    if not stream:
        return json.loads(r.read())["choices"][0]["message"]["content"]
    # SSE 流式解析
    parts = []
    for raw in r:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            delta = json.loads(data)["choices"][0]["delta"].get("content") or ""
        except (KeyError, IndexError, json.JSONDecodeError):
            continue
        if delta:
            print(delta, end="", flush=True)
            parts.append(delta)
    return "".join(parts)

# 文本（注意用路由别名）
chat("openpangu-2.0-pro", [{"role": "user", "content": "hi"}])
chat("GLM-5.2", [{"role": "user", "content": "hi"}])

# 多模态（supports_images: true 的模型原生接受 image_url 分片，
# 2026-11 起 glm-5.3-flash / deepseek-v4.1-flash / kimi-k3 系列均支持；
# 旧的 Qwen3-VL-235B 已从清单下线）
chat("glm-5.3-flash", [{"role": "user", "content": [
    {"type": "text", "text": "What color is this image?"},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,<BASE64>"}},
]}])
```
