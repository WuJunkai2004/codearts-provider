# AGENTS.md

OpenCode provider plugin for Huawei Cloud CodeArts (snap-access InferHub), signed with APIG `SDK-HMAC-SHA256`. Small TypeScript ESM package; the README is the authoritative spec (gateway routing rules, signing algorithm, endpoint list) — read it before touching `src/`.

## Commands

```bash
npm install
npm run build        # tsc -> dist/ (REQUIRED before test or plugin use)
npm run typecheck    # tsc --noEmit
npm test             # node --test "test/*.test.js" (39 unit tests, no network)
```

- **`npm test` requires `npm run build` first**: tests import from `../dist/*.js`, not `src/`. After editing `src/`, always rebuild before re-running tests or typecheck will pass while tests run stale code.
- `test/live-check.js` is a real-API smoke test, NOT run by `npm test` (glob only matches `*.test.js`). It needs `CODEARTS_CLI_AK`/`CODEARTS_CLI_SK` env vars and a fresh build: `node test/live-check.js`.
- Run a single test: `node --test --test-name-pattern "<pattern>" test/plugin.test.js`.
- On Windows Git Bash, use `npm.cmd` if bare `npm` is not found.
- Commits follow Conventional Commits in English (`fix:`, `feat:`, `refactor(scope):`, `docs:`); no CI, tags, or release flow exist.

## Architecture

- `src/index.ts` — plugin entry, V1 shape `export default { id, server }` with four hooks: `config` (register provider + inject signed fetch), `provider` (dynamic model refresh), `auth` (`/connect` two-step AK/SK flow: step 1 = AK via custom prompt, step 2 = SK via built-in API key page; stored as `key` = SK, `metadata.ak` = AK), `tool` (`codearts_vision`, only when `visionTool !== false`).
- `src/vision.ts` — backend of the `codearts_vision` tool: local file/URL → data URL → signed `/api/v2/chat/completions` call to the vision model → extracted text (`extractContent` handles both SSE and plain JSON).
- `src/signer.ts` — SDK-HMAC-SHA256 signing + `createSignedFetch` wrapper. Signs every request including streaming bodies (body SHA256 must be computed after serialization).
- `src/discover.ts` — model discovery via agent-center chain (`useragents` → `detail`), requires `Agent-Type: AgentCenter` header. Returns `[]` when the account has no enabled models (no hardcoded fallback).
- `src/cache.ts` — model-list file cache at `~/.local/share/opencode/codearts-models.json` (`{ base, fetchedAt, models }`, keyed by base URL; malformed/missing/mismatched-base all read as a miss). Writes are best-effort.
- `src/index.ts` — there are **no hardcoded models** (`EXTRA_MODELS` and `FALLBACK_MODELS` are gone). `fetchModels()` writes the cache on success and falls back on failure: in-memory `lastGoodModels` → file cache → `null`, where `null` makes the caller emit the `connect-required` hint model. `resolveBase()` strips a trailing `/api/v2`, so `baseURL` may be passed with or without it.
- `src/i18n.ts` — zh/en strings, language from `CODEARTS_LANG` > `LC_ALL` > `LANG`.
- `dist/` is the loaded artifact: opencode reads `exports["./server"]` → `dist/index.js`. `src/` is never imported at runtime.

## Critical protocol quirks (easy to break, hard to debug)

- **Model ID = `model_alias` (lowercase routing alias), display name = `model_name`.** Requesting by `model_name` fails with `InferHub.002002009 not registered`.
- **Canonical URI requires a trailing slash in the signature** (`/v1/sessions` signs as `/v1/sessions/`) while the actual request path is unchanged. Missing this → 401.
- **The OpenAI SDK's `Authorization: Bearer` header must be removed/replaced** by the Huawei signature header, or the gateway reports `APIG.0301 decrypt token fail`.
- **Headers are case-insensitively deduped before signing**: `user-agent` + `User-Agent` coexisting sends two headers but signs one → `APIG.0301 verify ak sk signature fail`.
- **Chat requests must mimic the CLI's exact request shape** (User-Agent `ai-sdk/provider-utils/4.0.21 runtime/bun/1.3.14`, full `x-ot-*` header set, body fields `stream: true` / `tool_stream` / `user_prompt`). The gateway routes by request shape; any missing piece lands on the wrong backend (Whitelabel 404 / not registered). Discovery endpoints do NOT need this shape.
- `user-session-id` is per-`createSignedFetch`-instance and counts against a 3-concurrent-session server limit; keep it stable per process. The vision tool isolates itself with an explicit `sessionId` (third arg of `createSignedFetch`) so a sub-call never shares the main chat's slot.
- **`hooks.tool` is static** (evaluated in `server()`, not populated by the `config` hook), so the vision tool cannot be gated on credentials at registration time — `/connect` credentials are not visible on first boot. It resolves credentials lazily at `execute` time and returns a `/connect` hint instead. `visionTool: false` removes the hook entirely.
- **Pasted images cannot be handled by the vision tool.** They arrive as `FilePart`s with `data:`/`file:` URLs; the main model cannot read them and the tool call never receives the bytes. A `chat.message` interception (stashing bytes under a handle, swapping the part for a `synthetic: true` hint) was tried and **removed**: the model ignored the injected handle and passed the attachment's filename instead, so the lookup always missed. The tool only supports an explicit `image` path or `image_url`.

## Credential priority

`provider options` > `plugin options` > env `CODEARTS_CLI_AK`/`CODEARTS_CLI_SK` > `/connect` stored auth. With no credentials the provider still registers with a single placeholder model `connect-required` and makes no inference calls.
