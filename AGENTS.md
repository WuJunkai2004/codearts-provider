# AGENTS.md

OpenCode provider plugin for Huawei Cloud CodeArts (snap-access InferHub), signed with APIG `SDK-HMAC-SHA256`. Small TypeScript ESM package; the README is the authoritative spec (gateway routing rules, signing algorithm, endpoint list) — read it before touching `src/`.

## Commands

```bash
npm install
npm run build        # tsc --noEmit + esbuild -> dist/index.js (the ONLY dist file; REQUIRED before plugin use)
npm run typecheck    # tsc --noEmit
npm test             # node --test "test/*.test.js" (pretest emits .tsc/ and rebuilds the bundle)
```

- Tests import scattered modules from `../.tsc/*` (tsc emit, gitignored) and the real published artifact from `../dist/index.js` (esbuild bundle). `pretest` runs both builds, so `npm test` is self-sufficient; a bare `node --test` needs `npm run build` first.
- `test/live-check.js` is a real-API smoke test, NOT run by `npm test` (glob only matches `*.test.js`). It needs `CODEARTS_CLI_AK`/`CODEARTS_CLI_SK` env vars and a fresh build: `node test/live-check.js`.
- Run a single test: `node --test --test-name-pattern "<pattern>" test/plugin.test.js`.
- On Windows Git Bash, use `npm.cmd` if bare `npm` is not found.
- Commits follow Conventional Commits in English (`fix:`, `feat:`, `refactor(scope):`, `docs:`); no CI, tags, or release flow exist.

## Architecture

- `src/index.ts` — thin dual-format entry, default export `{ id, server, setup }` (docs.build/plugins/migrate-v1 "Support V1 and V2 from one package"): V1 hosts call `server()`, V2 hosts call `setup(ctx)`. The V2 host validates `id` + `setup` and ignores unknown fields.
- `src/v1/index.ts` — the V1 `server()`: hooks `config` (register provider + inject signed fetch), `provider` (dynamic model refresh), `auth` (`/connect` two-step AK/SK flow: step 1 = AK via custom prompt, step 2 = SK via built-in API key page; stored as `key` = SK, `metadata.ak` = AK), `tool` (`codearts_vision`, only when `visionTool !== false`).
- `src/v2/index.ts` + `src/v2/types.ts` — the V2 `setup(ctx)`, mapping V1 hooks onto V2 domains per migrate-v1 + docs/build/plugins/effect: `config` → `ctx.provider.transform` (`editor.add({ info, models })` with `Provider.Info` fields `activation`/`package`/`settings`; falls back to `update` + `models.set`), `auth` → `ctx.integration.transform` (key method + AK form field), `tool` → `ctx.tool.transform` (JSON Schema in, `{ content }` out), and V1 `options.fetch` → `ctx.session.hook("http.request", …, { providerID })` via `signNativeRequest`. Domains are optional in the context type — a host without a domain skips that part instead of failing the plugin. No `@opencode-ai/*` runtime import in the V2 path.
- **V2 provider `settings` must stay JSON-safe** — the registry structured-clones definitions, so a function (e.g. an injected fetch) kills the whole transform with `DataCloneError` and the plugin is disabled ("看不到模型" was exactly this). Signing therefore happens on the wire in the `http.request` hook; request-time credentials come from `ctx.integration.connection.active/resolve` (same `key` = SK / `metadata.ak` = AK layout), resolved lazily per request. Models use the V2 `Model.Info` shape (`toModelInfo`: `modelID`, `capabilities.input` modality array, `cost` tier array, `enabled`, `time`); a 60s interval re-runs discovery and calls `ctx.provider.reload()` when the inventory changes. `setup` returns a cleanup that clears the interval.
- `src/utils/` — host-neutral logic shared by both entries: `models.ts` (`fetchModels` + fallbacks, `toModel`/`toConfigModel`), `credentials.ts` (AK/SK resolution, `/connect` storage parsing, `resolveBase`), `constants.ts` (ids), `paths.ts`, plus the API modules (`signer.ts`, `discover.ts`, `cache.ts`, `vision.ts`, `i18n.ts`, `opengw.ts`).
- `src/vision.ts` — backend of the `codearts_vision` tool: local file/URL → data URL → signed `/api/v2/chat/completions` call to the vision model → extracted text (`extractContent` handles both SSE and plain JSON).
- `src/utils/signer.ts` — SDK-HMAC-SHA256 signing + two wrappers over it: `createSignedFetch` (V1 `options.fetch`) and `signNativeRequest` (V2 `http.request`: Request → shaped, signed Request; session id = the host's real session). Shared helpers: `applyCliBodyShape`, `cliChatHeaders`, `collectHeaders`/`mergeHeaders` (case-insensitive dedupe, `authorization` stripped). Signs every request including streaming bodies (body SHA256 must be computed after serialization).
- `src/utils/discover.ts` — `discoverModels` orchestrates two sources: `discoverAgentCenter` (primary, fail-fast: `useragents` → `pickAgentId` → `detail`, requires `Agent-Type: AgentCenter`) and `discoverOpengw` (best-effort supplement, deduped by model id — errors only logged). Returns `[]` when the account has no enabled models (no hardcoded fallback).
- `src/utils/cache.ts` — model-list file cache at `~/.local/share/opencode/codearts-models.json` (`{ base, fetchedAt, models }`, keyed by base URL; malformed/missing/mismatched-base all read as a miss). Writes are best-effort.
- `src/utils/models.ts` — there are **no hardcoded models** (`EXTRA_MODELS` and `FALLBACK_MODELS` are gone). `fetchModels()` writes the cache on success and falls back on failure: in-memory `lastGoodModels` → file cache → `null`, where `null` makes the caller emit the `connect-required` hint model. `resolveBase()` (`src/utils/credentials.ts`) strips a trailing `/api/v2`, so `baseURL` may be passed with or without it.
- `src/utils/i18n.ts` — zh/en strings, language from `CODEARTS_LANG` > `LC_ALL` > `LANG`.
- `src/utils/opengw.ts` — runtime registry for opengw-discovered models (`syncOpengwModels` + `isOpengwModel`). Single writer is `models.ts` (every `fetchModels` path, including the no-creds and cache-fallback paths); single reader is `cliChatHeaders`. Discovered models carry `opengw: true` as plain data — never mutate the registry from discovery code.
- `src/utils/constants.ts` + `src/utils/credentials.ts` + `src/utils/paths.ts` — provider/tool ids, AK/SK credential resolution and `/connect` storage parsing, image-path resolution.
- `dist/` holds ONLY the single-file esbuild bundle `dist/index.js` — the loaded artifact and the only published file (`npm pack` = 3 files: this, README, package.json; zero declared deps). `tool()` + zod are inlined because V1 needs them at runtime; type-only imports are erased. tsc emits to `.tsc/` (gitignored, never published) purely for the tests. `src/` is never imported at runtime.

## Critical protocol quirks (easy to break, hard to debug)

- **Model ID = `model_alias` (lowercase routing alias), display name = `model_name`.** Requesting by `model_name` fails with `InferHub.002002009 not registered`.
- **Canonical URI requires a trailing slash in the signature** (`/v1/sessions` signs as `/v1/sessions/`) while the actual request path is unchanged. Missing this → 401.
- **The OpenAI SDK's `Authorization: Bearer` header must be removed/replaced** by the Huawei signature header, or the gateway reports `APIG.0301 decrypt token fail`.
- **`signNativeRequest` must drop the original `content-length`** before building the replacement Request: the CLI body shaping grows the body, and a stale length makes the gateway hash a truncated body → 401 signature failure (indistinguishable from bad AK/SK at the error level).
- **Headers are case-insensitively deduped before signing**: `user-agent` + `User-Agent` coexisting sends two headers but signs one → `APIG.0301 verify ak sk signature fail`.
- **Chat requests must mimic the CLI's exact request shape** (User-Agent `ai-sdk/provider-utils/4.0.21 runtime/bun/1.3.14`, full `x-ot-*` header set, body fields `stream: true` / `tool_stream` / `user_prompt`). The gateway routes by request shape; any missing piece lands on the wrong backend (Whitelabel 404 / not registered). Discovery endpoints do NOT need this shape.
- `user-session-id` is per-`createSignedFetch`-instance and counts against a 3-concurrent-session server limit; keep it stable per process. The vision tool isolates itself with an explicit `sessionId` (third arg of `createSignedFetch`) so a sub-call never shares the main chat's slot.
- **`hooks.tool` is static** (evaluated in `server()`, not populated by the `config` hook), so the vision tool cannot be gated on credentials at registration time — `/connect` credentials are not visible on first boot. It resolves credentials lazily at `execute` time and returns a `/connect` hint instead. `visionTool: false` removes the hook entirely.
- **Pasted images cannot be handled by the vision tool.** They arrive as `FilePart`s with `data:`/`file:` URLs; the main model cannot read them and the tool call never receives the bytes. A `chat.message` interception (stashing bytes under a handle, swapping the part for a `synthetic: true` hint) was tried and **removed**: the model ignored the injected handle and passed the attachment's filename instead, so the lookup always missed. The tool only supports an explicit `image` path or `image_url`.

## Credential priority

`provider options` > `plugin options` > env `CODEARTS_CLI_AK`/`CODEARTS_CLI_SK` > `/connect` connection (V2: `ctx.integration.connection`) > `/connect` stored auth (`auth.json`). With no credentials the provider still registers with a single placeholder model `connect-required` and makes no inference calls.

## V2 entry resolution (opencode 2.x loader)

- A **directory** target resolves its server entry by trying `<dir>/server.*` then `<dir>/index.*` (Bun resolution); a **file** target is the entry; an npm package uses `exports["./server"]` (fallback `main`). The TUI/CLI (`cli.json`) resolves the **`tui.*` entry** instead — a server plugin registered in `cli.json` is never loaded by the server; register server plugins under `plugins` in `opencode.json(c)`.
- The loaded module's default export must carry `id` + `setup` (or `effect`); anything else is rejected with "Plugin must export a default definition with an id and an effect or setup function."
