import { test } from "node:test"
import assert from "node:assert/strict"
import { signRequest, sdkDate, createSignedFetch, signNativeRequest } from "../dist/utils/signer.js"
import { discoverModels, pickAgentId } from "../dist/utils/discover.js"
import { extractContent, imageToDataUrl } from "../dist/utils/vision.js"
import { readModelCache, writeModelCache } from "../dist/utils/cache.js"
import { toModelInfo } from "../dist/utils/models.js"
import { mkdirSync, writeFileSync } from "node:fs"

const AK = "TESTAK"
const SK = "TESTSK"

// Machine-state isolation: readStoredAuth() reads the real
// ~/.local/share/opencode/auth.json (and caches per module instance), and
// CODEARTS_CLI_AK/SK may leak from the environment. Both would make
// "no credentials" tests hit the real network. Point HOME at an empty temp
// dir so the auth store lookup always misses, and scrub env credentials.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const FAKE_HOME = mkdtempSync(join(tmpdir(), "codearts-test-home-"))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME
delete process.env.CODEARTS_CLI_AK
delete process.env.CODEARTS_CLI_SK
delete process.env.CODEARTS_CLI_BASE

test("sdkDate format", () => {
  assert.equal(sdkDate(new Date("2026-09-09T12:34:56.789Z")), "20260909T123456Z")
})

test("signRequest: fixed vector (GET, no query)", () => {
  const headers = signRequest("GET", "https://example.com/v1/models", AK, SK, { "X-Language": "zh-cn" }, "")
  assert.equal(headers["X-Sdk-Date"], sdkDate())
  assert.match(headers.Authorization, /^SDK-HMAC-SHA256 Access=TESTAK, SignedHeaders=/)
  assert.match(headers.Authorization, /SignedHeaders=host;x-language;x-sdk-date/)
  // deterministic: signature only depends on date + inputs
  const again = signRequest("GET", "https://example.com/v1/models", AK, SK, { "X-Language": "zh-cn" }, "")
  assert.equal(headers.Authorization, again.Authorization)
})

test("signRequest: trailing slash appended to canonical path", () => {
  const h1 = signRequest("POST", "https://example.com/v1/sessions", AK, SK, {}, "{}")
  const h2 = signRequest("POST", "https://example.com/v1/sessions/", AK, SK, {}, "{}")
  assert.equal(h1.Authorization, h2.Authorization)
})

test("signRequest: query params sorted and encoded", () => {
  const h = signRequest(
    "GET",
    "https://example.com/v1/list?b=2&a=1&empty=",
    AK,
    SK,
    {},
    "",
  )
  assert.match(h.Authorization, /Signature=[0-9a-f]{64}$/)
})

test("signRequest: body hashed into signature", () => {
  const a = signRequest("POST", "https://example.com/api/v2/chat/completions", AK, SK, {}, '{"model":"x"}')
  const b = signRequest("POST", "https://example.com/api/v2/chat/completions", AK, SK, {}, '{"model":"y"}')
  assert.notEqual(a.Authorization, b.Authorization)
})

test("signRequest: different SK -> different signature", () => {
  const a = signRequest("GET", "https://example.com/x", AK, "SK1", {}, "")
  const b = signRequest("GET", "https://example.com/x", AK, "SK2", {}, "")
  assert.notEqual(a.Authorization, b.Authorization)
})

test("createSignedFetch signs outgoing request", async (t) => {
  let captured = null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    captured = { input: typeof input === "string" ? input : input.url, init }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })

  const signedFetch = createSignedFetch(AK, SK)
  const res = await signedFetch("https://example.com/api/v2/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "GLM-5.2", messages: [] }),
  })
  assert.equal(res.status, 200)
  assert.ok(captured, "fetch called")
  const auth = captured.init.headers.Authorization ?? captured.init.headers.get?.("Authorization")
  assert.match(auth, /^SDK-HMAC-SHA256 Access=TESTAK/)
  assert.ok(captured.init.headers["X-Sdk-Date"])
})

test("createSignedFetch adds CLI routing headers + body fields on chat requests", async (t) => {
  let captured = null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    captured = { input: typeof input === "string" ? input : input.url, init }
    return new Response("data: [DONE]", { status: 200 })
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })

  const signedFetch = createSignedFetch(AK, SK)
  await signedFetch("https://example.com/api/v2/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openpangu-2.0-pro",
      max_tokens: 100,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "介绍你自己" },
      ],
    }),
  })

  const h = captured.init.headers
  assert.equal(h["User-Agent"], "ai-sdk/provider-utils/4.0.21 runtime/bun/1.3.14", "CLI user-agent")
  assert.equal(h["model-id"], "openpangu-2.0-pro", "model-id routing header")
  assert.match(h["x-snap-traceid"], /^[0-9a-f]{32}_[0-9a-f]{16}$/, "snap traceid 32_16 hex")
  assert.ok(h["user-session-id"]?.startsWith("ses_"), "session header")
  assert.ok(h["x-ot-session-id"] === h["user-session-id"], "ot session matches")

  const body = JSON.parse(captured.init.body)
  assert.equal(body.stream, true, "stream forced on")
  assert.equal(body.tool_stream, true, "tool_stream added")
  assert.equal(body.user_prompt, "介绍你自己", "user_prompt = last user message")
  assert.equal(body.model, "openpangu-2.0-pro", "model unchanged")
})

test("createSignedFetch leaves non-chat requests untouched", async (t) => {
  let captured = null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    captured = { input: typeof input === "string" ? input : input.url, init }
    return new Response("{}", { status: 200 })
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })

  const signedFetch = createSignedFetch(AK, SK)
  await signedFetch("https://example.com/v1/agent-center/agents/useragents?offset=0", {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  })
  assert.equal(captured.init.headers["model-id"], undefined, "no CLI headers on discovery calls")
  assert.equal(captured.init.body, undefined, "no body on GET")
})

test("pickAgentId prefers CLI-capable / CodeAgent / primary", () => {
  const agents = [
    { agent_id: "aaa", supported_clients: ["VSCODE_H"] },
    { agent_id: "bbb", supported_clients: ["CLI"], agent_name: "CodeAgent", is_primary_agent: true },
  ]
  assert.equal(pickAgentId({ agents }), "bbb")
  assert.equal(pickAgentId({ agents: [{ agent_id: "zzz" }] }), "zzz")
  assert.equal(pickAgentId({}), undefined)
})

test("discoverModels maps gpts.models into provider models", async (t) => {
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (input) => {
    calls++
    const url = String(input)
    if (url.includes("useragents")) {
      assert.match(url, /agent-center\/agents\/useragents\?offset=0&limit=100/)
      return Response.json({ agents: [{ agent_id: "ag1", supported_clients: ["CLI"] }] })
    }
    if (url.includes("agents/detail")) {
      assert.ok(url.includes("agent_id=ag1"))
      return Response.json({
        gpts: {
          models: [
            {
              model_name: "GLM-5.2",
              model_alias: "GLM-5.2",
              model_parameters: { context_window: 202752, max_tokens: 131072, thinking_type: 1, supports_images: false },
            },
            {
              model_name: "Hidden",
              model_parameters: { display_enabled: false },
            },
          ],
        },
      })
    }
    throw new Error("unexpected url " + url)
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })

  const models = await discoverModels(AK, SK, "https://example.com")
  assert.equal(calls, 2)
  assert.equal(models.length, 1)
  assert.equal(models[0].id, "GLM-5.2")
  assert.equal(models[0].context, 202752)
  assert.equal(models[0].reasoning, true)
})

test("plugin module default-exports V1 shape { id, server }", async () => {
  const mod = await import("../dist/index.js")
  assert.equal(mod.default.id, "opencode-codearts-provider")
  assert.equal(typeof mod.default.server, "function")
})

test("server() returns hooks with config/provider/auth", async (t) => {
  const savedAk = process.env.CODEARTS_CLI_AK
  const savedSk = process.env.CODEARTS_CLI_SK
  delete process.env.CODEARTS_CLI_AK
  delete process.env.CODEARTS_CLI_SK
  t.after(() => {
    if (savedAk !== undefined) process.env.CODEARTS_CLI_AK = savedAk
    if (savedSk !== undefined) process.env.CODEARTS_CLI_SK = savedSk
  })

  const mod = await import("../dist/index.js?no-creds")
  const hooks = await mod.default.server({ client: {}, project: {}, directory: ".", worktree: ".", $: {} }, {})
  assert.ok(hooks.config, "config hook")
  assert.equal(hooks.provider.id, "codearts")
  assert.equal(typeof hooks.provider.models, "function")
  assert.equal(hooks.auth.provider, "codearts")

  const cfg = {}
  await hooks.config(cfg)
  const provider = cfg.provider.codearts
  assert.ok(provider, "provider registered even without credentials (visible in /connect)")
  assert.equal(provider.options.fetch, undefined, "no signed fetch without credentials")
  const ids = Object.keys(provider.models)
  assert.deepEqual(ids, ["connect-required"], "single hint model without credentials")
  assert.match(provider.models["connect-required"].name, /connect/i)

  const models = await hooks.provider.models(
    { options: { baseURL: "https://example.com/api/v2" } },
    { auth: undefined },
  )
  // no creds -> hint model only
  assert.deepEqual(Object.keys(models), ["connect-required"])
  assert.match(models["connect-required"].name, /connect/i)

  // auth loader: two-step shape -> signed fetch + placeholder apiKey
  const opts = await hooks.auth.loader(async () => ({
    type: "api",
    key: "MYSK",
    metadata: { ak: "MYAK" },
  }))
  assert.equal(opts.apiKey, "codearts-signed")
  assert.equal(typeof opts.fetch, "function")
})

test("hint model name is i18n-aware (zh vs en, CODEARTS_LANG override)", async () => {
  const mod = await import("../dist/index.js?i18n")
  const hooks = await mod.default.server({}, {})
  const cfg = {}
  const saved = process.env.CODEARTS_LANG
  const savedLang = process.env.LANG
  try {
    delete process.env.LANG
    delete process.env.CODEARTS_LANG
    let m = await hooks.provider.models({ options: {} }, { auth: undefined })
    assert.match(m["connect-required"].name, /^Not connected/, "default English hint")

    process.env.CODEARTS_LANG = "zh"
    m = await hooks.provider.models({ options: {} }, { auth: undefined })
    assert.match(m["connect-required"].name, /未连接.*\/connect/, "Chinese hint via CODEARTS_LANG")

    process.env.CODEARTS_LANG = "en_US.UTF-8"
    m = await hooks.provider.models({ options: {} }, { auth: undefined })
    assert.match(m["connect-required"].name, /^Not connected/, "CODEARTS_LANG=en_US still English")
  } finally {
    if (saved === undefined) delete process.env.CODEARTS_LANG
    else process.env.CODEARTS_LANG = saved
    if (savedLang === undefined) delete process.env.LANG
    else process.env.LANG = savedLang
  }
})

test("auth loader: /connect two-step shape (key=SK, metadata.ak=AK)", async () => {
  const mod = await import("../dist/index.js?meta-ak")
  const hooks = await mod.default.server({}, {})
  const opts = await hooks.auth.loader(async () => ({
    type: "api",
    key: "MYSK",
    metadata: { ak: "MYAK" },
  }))
  assert.equal(typeof opts.fetch, "function")
  assert.equal(opts.apiKey, "codearts-signed")
})

test("auth loader: combined legacy shape is rejected", async () => {
  const mod = await import("../dist/index.js?combined-key")
  const hooks = await mod.default.server({}, {})
  const opts = await hooks.auth.loader(async () => ({
    type: "api",
    key: "MYAK/MYSK",
  }))
  assert.deepEqual(opts, {}, "combined AK/SK key is no longer a valid storage shape")
})

test("auth loader: partial credentials -> empty options", async () => {
  const mod = await import("../dist/index.js?partial")
  const hooks = await mod.default.server({}, {})
  // SK only, no metadata.ak
  const opts = await hooks.auth.loader(async () => ({ type: "api", key: "MYSK" }))
  assert.deepEqual(opts, {})
  // SK with unrelated metadata
  const opts2 = await hooks.auth.loader(async () => ({
    type: "api",
    key: "MYSK",
    metadata: { other: "x" },
  }))
  assert.deepEqual(opts2, {})
})

test("auth method labels are i18n-aware", async () => {
  const mod = await import("../dist/index.js?auth-i18n")
  const saved = process.env.CODEARTS_LANG
  try {
    delete process.env.CODEARTS_LANG
    let hooks = await mod.default.server({}, {})
    let m = hooks.auth.methods[0]
    assert.match(m.label, /SK, step 2\/2/)
    assert.match(m.prompts[0].message, /AK, step 1\/2/)

    process.env.CODEARTS_LANG = "zh"
    hooks = await mod.default.server({}, {})
    m = hooks.auth.methods[0]
    assert.match(m.label, /SK，第 2\/2 步/)
    assert.match(m.prompts[0].message, /AK，第 1\/2 步/)
  } finally {
    if (saved === undefined) delete process.env.CODEARTS_LANG
    else process.env.CODEARTS_LANG = saved
  }
})

test("auth loader: no auth -> empty options", async () => {
  const mod = await import("../dist/index.js?no-auth")
  const hooks = await mod.default.server({}, {})
  const opts = await hooks.auth.loader(async () => undefined)
  assert.deepEqual(opts, {})
})

test("with env credentials provider is registered with discovered models", async (t) => {
  const savedAk = process.env.CODEARTS_CLI_AK
  const savedSk = process.env.CODEARTS_CLI_SK
  process.env.CODEARTS_CLI_AK = "TESTAK"
  process.env.CODEARTS_CLI_SK = "TESTSK"
  t.after(() => {
    if (savedAk === undefined) delete process.env.CODEARTS_CLI_AK
    else process.env.CODEARTS_CLI_AK = savedAk
    if (savedSk === undefined) delete process.env.CODEARTS_CLI_SK
    else process.env.CODEARTS_CLI_SK = savedSk
  })

  const realFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("useragents")) {
      return Response.json({ agents: [{ agent_id: "ag1", supported_clients: ["CLI"] }] })
    }
    if (url.includes("agents/detail")) {
      return Response.json({
        gpts: {
          models: [
            {
              model_name: "GLM-5.2",
              model_alias: "GLM-5.2",
              model_parameters: { context_window: 202752, max_tokens: 131072, thinking_type: 1, supports_images: false },
            },
          ],
        },
      })
    }
    throw new Error("unexpected url " + url)
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })

  const mod = await import("../dist/index.js?with-creds")
  const hooks = await mod.default.server({}, {})
  const cfg = {}
  await hooks.config(cfg)
  const provider = cfg.provider.codearts
  assert.ok(provider, "provider registered with credentials")
  assert.equal(typeof provider.options.fetch, "function", "signed fetch injected")
  assert.equal(provider.options.apiKey, "codearts-signed")
  const names = Object.keys(provider.models)
  assert.deepEqual(names, ["GLM-5.2"], "only discovered models, no hardcoded extras")

  const models = await hooks.provider.models({ options: { baseURL: "https://example.com/api/v2" } }, { auth: undefined })
  assert.equal(models["GLM-5.2"].capabilities.input.image, false, "GLM not multimodal")
})

test("readModelCache round-trips and rejects mismatched base", () => {
  const p = join(FAKE_HOME, "cache-roundtrip.json")
  const models = [{ id: "GLM-5.2", name: "GLM-5.2", context: 202752 }]
  writeModelCache("https://example.com", models, p)

  const hit = readModelCache("https://example.com", p)
  assert.ok(hit, "cache hit for same base")
  assert.equal(hit.models[0].id, "GLM-5.2")
  assert.ok(typeof hit.fetchedAt === "number", "fetchedAt recorded")

  assert.equal(readModelCache("https://other.com", p), null, "base mismatch = miss")
  assert.equal(readModelCache("https://example.com", join(FAKE_HOME, "nope.json")), null, "missing file = miss")
})

test("readModelCache tolerates malformed cache files", () => {
  const bad = join(FAKE_HOME, "cache-bad.json")
  writeFileSync(bad, "{not json")
  assert.equal(readModelCache("https://example.com", bad), null, "invalid JSON = miss")
  writeFileSync(bad, JSON.stringify({ base: "https://example.com", models: "nope" }))
  assert.equal(readModelCache("https://example.com", bad), null, "non-array models = miss")
})

test("discovery failure falls back to the file cache, not hardcoded models", async (t) => {
  const savedAk = process.env.CODEARTS_CLI_AK
  const savedSk = process.env.CODEARTS_CLI_SK
  process.env.CODEARTS_CLI_AK = "TESTAK"
  process.env.CODEARTS_CLI_SK = "TESTSK"
  t.after(() => {
    if (savedAk === undefined) delete process.env.CODEARTS_CLI_AK
    else process.env.CODEARTS_CLI_AK = savedAk
    if (savedSk === undefined) delete process.env.CODEARTS_CLI_SK
    else process.env.CODEARTS_CLI_SK = savedSk
  })

  // Seed the real cache path (~/.local/share/opencode under the fake HOME).
  mkdirSync(join(FAKE_HOME, ".local", "share", "opencode"), { recursive: true })
  writeModelCache("https://example.com", [
    { id: "openpangu-2.0-pro", name: "OpenPangu-2.0-Pro", context: 131072, output: 32768 },
  ])

  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error("network down")
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })

  const realError = console.error
  console.error = () => {}
  t.after(() => {
    console.error = realError
  })

  const mod = await import("../dist/index.js?cache-fallback")
  const hooks = await mod.default.server({}, { baseURL: "https://example.com" })
  const models = await hooks.provider.models({ options: { baseURL: "https://example.com/api/v2" } }, { auth: undefined })
  assert.deepEqual(Object.keys(models), ["openpangu-2.0-pro"], "cached models served on failure")
  assert.equal(models["openpangu-2.0-pro"].capabilities.input.image, false)
})

test("empty discovery does not poison the cache with hardcoded models", async (t) => {
  const savedAk = process.env.CODEARTS_CLI_AK
  const savedSk = process.env.CODEARTS_CLI_SK
  process.env.CODEARTS_CLI_AK = "TESTAK"
  process.env.CODEARTS_CLI_SK = "TESTSK"
  t.after(() => {
    if (savedAk === undefined) delete process.env.CODEARTS_CLI_AK
    else process.env.CODEARTS_CLI_AK = savedAk
    if (savedSk === undefined) delete process.env.CODEARTS_CLI_SK
    else process.env.CODEARTS_CLI_SK = savedSk
  })

  const realFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("useragents")) return Response.json({ agents: [{ agent_id: "ag1", supported_clients: ["CLI"] }] })
    if (url.includes("agents/detail")) return Response.json({ gpts: { models: [] } })
    throw new Error("unexpected url " + url)
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })

  // Distinct base so the cache seeded by the previous test is not reused.
  const mod = await import("../dist/index.js?empty-discovery")
  const hooks = await mod.default.server({}, { baseURL: "https://empty.example.com" })
  const models = await hooks.provider.models({ options: { baseURL: "https://empty.example.com/api/v2" } }, { auth: undefined })
  assert.deepEqual(Object.keys(models), ["connect-required"], "empty discovery -> hint model, no invented models")
})

test("createSignedFetch accepts an explicit sessionId (vision slot isolation)", async (t) => {
  let captured = null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    captured = { init }
    return new Response("data: [DONE]", { status: 200 })
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })

  const signedFetch = createSignedFetch(AK, SK, { sessionId: "ses_vision_fixed" })
  await signedFetch("https://example.com/api/v2/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "Qwen3-VL-235B", messages: [] }),
  })
  assert.equal(captured.init.headers["user-session-id"], "ses_vision_fixed")
  assert.equal(captured.init.headers["x-ot-session-id"], "ses_vision_fixed")
})

test("extractContent parses SSE deltas and plain JSON", () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"红色"}}]}',
    'data: {"choices":[{"delta":{"content":"的圆"}}]}',
    "data: [DONE]",
  ].join("\n")
  assert.equal(extractContent(sse, "text/event-stream"), "红色的圆")

  const json = JSON.stringify({ choices: [{ message: { content: "hello" } }] })
  assert.equal(extractContent(json, "application/json"), "hello")

  assert.equal(extractContent("garbage", null), "")
  assert.equal(extractContent('{"choices":[]}', "application/json"), "")
})

test("imageToDataUrl encodes local file with mime from extension", () => {
  const png = join(FAKE_HOME, "tiny.png")
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const url = imageToDataUrl(png)
  assert.match(url, /^data:image\/png;base64,/)
  assert.equal(Buffer.from(url.split(",")[1], "base64").length, 4)

  const jpg = join(FAKE_HOME, "tiny.JPG")
  writeFileSync(jpg, Buffer.from([0xff, 0xd8]))
  assert.match(imageToDataUrl(jpg), /^data:image\/jpeg;base64,/, "extension match is case-insensitive")
})

test("codearts_vision tool is registered by default and disabled via visionTool:false", async () => {
  const mod = await import("../dist/index.js?vision-tool")
  const hooks = await mod.default.server({}, {})
  assert.ok(hooks.tool, "tool hook present by default")
  const def = hooks.tool["codearts_vision"]
  assert.ok(def, "codearts_vision registered")
  assert.equal(typeof def.execute, "function")
  assert.ok(def.args.image, "image arg")
  assert.ok(def.args.image_url, "image_url arg")
  assert.ok(def.args.prompt, "prompt arg")

  const off = await mod.default.server({}, { visionTool: false })
  assert.equal(off.tool, undefined, "visionTool:false removes the tool hook")
})

test("codearts_vision executes against the gateway and returns text", async (t) => {
  const realFetch = globalThis.fetch
  let captured = null
  globalThis.fetch = async (input, init) => {
    captured = { url: String(input), init }
    return new Response(
      'data: {"choices":[{"delta":{"content":"A small red circle."}}]}\n\ndata: [DONE]\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })

  const png = join(FAKE_HOME, "shot.png")
  writeFileSync(png, Buffer.from([1, 2, 3, 4]))

  const mod = await import("../dist/index.js?vision-exec")
  const hooks = await mod.default.server({}, { ak: "TESTAK", sk: "TESTSK", baseURL: "https://example.com" })
  const res = await hooks.tool["codearts_vision"].execute(
    { image: png, prompt: "What is this?" },
    { directory: FAKE_HOME, abort: undefined },
  )

  assert.equal(captured.url, "https://example.com/api/v2/chat/completions")
  const h = captured.init.headers
  assert.equal(h["model-id"], "Qwen3-VL-235B", "default vision model")
  assert.equal(h["User-Agent"], "ai-sdk/provider-utils/4.0.21 runtime/bun/1.3.14", "CLI shape")
  assert.match(h.Authorization, /^SDK-HMAC-SHA256 Access=TESTAK/)

  const body = JSON.parse(captured.init.body)
  assert.equal(body.model, "Qwen3-VL-235B")
  assert.equal(body.user_prompt, "What is this?")
  assert.equal(body.messages[0].content[0].type, "text")
  assert.equal(body.messages[0].content[0].text, "What is this?")
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/)
  assert.equal(res.output, "A small red circle.")
  assert.match(res.title, /Qwen3-VL-235B/)
})

test("codearts_vision honours a custom visionModel", async (t) => {
  const realFetch = globalThis.fetch
  let captured = null
  globalThis.fetch = async (input, init) => {
    captured = { init }
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}', { status: 200 })
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })

  const mod = await import("../dist/index.js?vision-model")
  const hooks = await mod.default.server({}, { ak: "TESTAK", sk: "TESTSK", visionModel: "Qwen3.6-27B-VL" })
  await hooks.tool["codearts_vision"].execute(
    { image_url: "data:image/png;base64,AAAA", prompt: "hi" },
    { directory: FAKE_HOME, abort: undefined },
  )
  assert.equal(captured.init.headers["model-id"], "Qwen3.6-27B-VL")
  assert.equal(JSON.parse(captured.init.body).model, "Qwen3.6-27B-VL")
})

test("codearts_vision errors clearly without image / without credentials", async () => {
  const mod = await import("../dist/index.js?vision-errors")
  const ctx = { directory: FAKE_HOME, abort: undefined }

  const withCreds = await mod.default.server({}, { ak: "TESTAK", sk: "TESTSK" })
  await assert.rejects(
    () => withCreds.tool["codearts_vision"].execute({ prompt: "hi" }, ctx),
    /image|image_url/i,
    "missing image argument rejected",
  )

  const noCreds = await mod.default.server({}, {})
  await assert.rejects(
    () => noCreds.tool["codearts_vision"].execute({ image_url: "data:image/png;base64,AA" }, ctx),
    /connect|AK\/SK/i,
    "no credentials rejected with connect hint",
  )
})

test("codearts_vision reports gateway errors", async (t) => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response('{"error":"InferHub.002002009 not registered"}', { status: 400 })
  t.after(() => {
    globalThis.fetch = realFetch
  })

  const mod = await import("../dist/index.js?vision-http-error")
  const hooks = await mod.default.server({}, { ak: "TESTAK", sk: "TESTSK" })
  await assert.rejects(
    () => hooks.tool["codearts_vision"].execute({ image_url: "data:image/png;base64,AA" }, { directory: FAKE_HOME, abort: undefined }),
    /HTTP 400.*not registered/s,
  )
})

test("V2: toModelInfo matches the V2 Model.Info shape", () => {
  const info = toModelInfo({
    id: "openpangu-2.0-pro",
    name: "OpenPangu-2.0-Pro",
    context: 131072,
    output: 32768,
    images: true,
    reasoning: true,
  })
  assert.equal(info.id, "openpangu-2.0-pro")
  assert.equal(info.modelID, "openpangu-2.0-pro")
  assert.equal(info.providerID, "codearts")
  assert.deepEqual(info.capabilities.input, ["text", "image"], "modality arrays, not objects")
  assert.deepEqual(info.capabilities.output, ["text"])
  assert.ok(Array.isArray(info.cost), "cost is an array of tiers")
  assert.equal(info.enabled, true)
  assert.deepEqual(info.variants, [])
  assert.deepEqual(info.limit, { context: 131072, output: 32768 })
  // must survive a structured clone (no functions/symbols anywhere)
  const clone = JSON.parse(JSON.stringify(info))
  assert.deepEqual(clone, info)
})

test("signNativeRequest signs and shapes a chat Request (V2 http.request)", async () => {
  const req = new Request("https://example.com/api/v2/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sk-must-not-reach-gateway",
    },
    body: JSON.stringify({
      model: "openpangu-2.0-pro",
      messages: [{ role: "user", content: "hi" }],
    }),
  })
  const out = await signNativeRequest(req, AK, SK, "ses_real_session")
  assert.match(out.headers.get("authorization"), /^SDK-HMAC-SHA256 Access=TESTAK/, "Bearer replaced by signature")
  assert.equal(out.headers.get("user-session-id"), "ses_real_session", "gateway session follows host session")
  assert.equal(out.headers.get("model-id"), "openpangu-2.0-pro")
  assert.equal(out.headers.get("content-type"), "application/json", "original headers kept")

  const body = JSON.parse(await out.text())
  assert.equal(body.stream, true)
  assert.equal(body.tool_stream, true)
  assert.equal(body.user_prompt, "hi")
  assert.equal(body.model, "openpangu-2.0-pro")
})

test("signNativeRequest leaves non-chat requests unshaped but signed", async () => {
  const req = new Request("https://example.com/v1/agent-center/agents/useragents?offset=0&limit=100")
  const out = await signNativeRequest(req, AK, SK)
  assert.match(out.headers.get("authorization"), /^SDK-HMAC-SHA256 Access=TESTAK/)
  assert.equal(out.headers.get("model-id"), null, "no CLI routing headers on discovery calls")
  assert.equal(await out.text(), "", "GET keeps no body")
})

// ---------------------------------------------------------------------------
// V2 setup(ctx): provider/integration/tool transforms + http.request signing
// ---------------------------------------------------------------------------

function makeV2Context(options = {}) {
  const recorded = {
    providerCalls: [],
    sessionHooks: [],
    integrationCalls: [],
    tools: [],
    reloads: 0,
  }
  const ctx = {
    options,
    location: { directory: FAKE_HOME },
    provider: {
      transform: async (cb) => {
        const calls = []
        cb({
          add: (input) => calls.push({ op: "add", input }),
          update: (...a) => calls.push({ op: "update", args: a }),
          models: { set: (...a) => calls.push({ op: "models.set", args: a }) },
        })
        recorded.providerCalls.push(calls)
      },
      reload: async () => {
        recorded.reloads++
      },
    },
    integration: {
      transform: async (cb) => {
        cb({ method: { update: (input) => recorded.integrationCalls.push(input) } })
      },
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
      },
    },
    tool: {
      transform: async (cb) => {
        cb({ add: (tool) => recorded.tools.push(tool) })
      },
    },
    session: {
      hook: async (name, cb, opts) => {
        recorded.sessionHooks.push({ name, cb, opts })
      },
    },
  }
  return { ctx, recorded }
}

test("V2 setup: provider transform registers JSON-safe source without credentials", async () => {
  const mod = await import("../dist/index.js?v2-setup")
  const { ctx, recorded } = makeV2Context({ baseURL: "https://example.com" })
  const cleanup = await mod.default.setup(ctx)

  assert.equal(typeof cleanup, "function", "setup returns a cleanup function")
  cleanup()

  const add = recorded.providerCalls[0].find((c) => c.op === "add")
  assert.ok(add, "provider source contributed via editor.add")
  const { info, models } = add.input
  assert.equal(info.id, "codearts")
  assert.equal(info.activation, "enabled", "stays registered for /connect without creds")
  assert.equal(info.package, "@opencode/ai/providers/openai-compatible")
  assert.equal(info.settings.baseURL, "https://example.com/api/v2")
  assert.equal(info.settings.apiKey, "codearts-signed")
  // the DataCloneError regression: no function may hide in settings
  assert.deepEqual(JSON.parse(JSON.stringify(info.settings)), info.settings, "settings JSON-safe")

  assert.equal(models.length, 1)
  assert.equal(models[0].id, "connect-required", "hint model without credentials")
  assert.equal(models[0].modelID, "connect-required")
  assert.match(models[0].name, /connect/i)
})

test("V2 setup: http.request hook is provider-scoped and signs requests", async (t) => {
  const savedAk = process.env.CODEARTS_CLI_AK
  const savedSk = process.env.CODEARTS_CLI_SK
  process.env.CODEARTS_CLI_AK = "TESTAK"
  process.env.CODEARTS_CLI_SK = "TESTSK"
  t.after(() => {
    if (savedAk === undefined) delete process.env.CODEARTS_CLI_AK
    else process.env.CODEARTS_CLI_AK = savedAk
    if (savedSk === undefined) delete process.env.CODEARTS_CLI_SK
    else process.env.CODEARTS_CLI_SK = savedSk
  })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("useragents")) return Response.json({ agents: [{ agent_id: "ag1", supported_clients: ["CLI"] }] })
    if (url.includes("agents/detail")) {
      return Response.json({
        gpts: {
          models: [
            {
              model_name: "OpenPangu-2.0-Pro",
              model_alias: "openpangu-2.0-pro",
              model_parameters: { context_window: 131072, max_tokens: 32768 },
            },
          ],
        },
      })
    }
    throw new Error("unexpected url " + url)
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })

  const mod = await import("../dist/index.js?v2-hook")
  const { ctx, recorded } = makeV2Context({ baseURL: "https://example.com" })
  const cleanup = await mod.default.setup(ctx)
  cleanup()

  const hook = recorded.sessionHooks.find((h) => h.name === "http.request")
  assert.ok(hook, "http.request hook registered")
  assert.deepEqual(hook.opts, { providerID: "codearts" }, "hook scoped to the provider")

  // discovered models (not the hint) ride the provider source
  const add = recorded.providerCalls[0].find((c) => c.op === "add")
  assert.deepEqual(add.input.models.map((m) => m.id), ["openpangu-2.0-pro"])

  // foreign-provider events pass through untouched
  const foreign = {
    sessionID: "ses_other",
    model: { providerID: "anthropic", id: "claude" },
    request: new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
  }
  await hook.cb(foreign)
  assert.equal(foreign.request.headers.get("authorization"), null, "foreign provider untouched")

  // own-provider events get a signed replacement request
  const event = {
    sessionID: "ses_main",
    model: { providerID: "codearts", id: "openpangu-2.0-pro" },
    request: new Request("https://example.com/api/v2/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer placeholder" },
      body: JSON.stringify({ model: "openpangu-2.0-pro", messages: [{ role: "user", content: "介绍你自己" }] }),
    }),
  }
  await hook.cb(event)
  assert.match(event.request.headers.get("authorization"), /^SDK-HMAC-SHA256 Access=TESTAK/)
  assert.equal(event.request.headers.get("user-session-id"), "ses_main")
  const body = JSON.parse(await event.request.text())
  assert.equal(body.stream, true)
  assert.equal(body.user_prompt, "介绍你自己")
})

test("V2 setup: without credentials the hook leaves requests unsigned", async () => {
  const mod = await import("../dist/index.js?v2-noauth")
  const { ctx, recorded } = makeV2Context({})
  const cleanup = await mod.default.setup(ctx)
  cleanup()

  const hook = recorded.sessionHooks.find((h) => h.name === "http.request")
  const event = {
    sessionID: "ses_main",
    model: { providerID: "codearts", id: "connect-required" },
    request: new Request("https://example.com/api/v2/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "connect-required", messages: [] }),
    }),
  }
  await hook.cb(event)
  assert.equal(event.request.headers.get("authorization"), null, "no signature without credentials")
})

test("V2 setup: integration key method collects the AK, tool is registered", async () => {
  const mod = await import("../dist/index.js?v2-auth")
  const { ctx, recorded } = makeV2Context({})
  const cleanup = await mod.default.setup(ctx)
  cleanup()

  const method = recorded.integrationCalls[0]
  assert.equal(method.integrationID, "codearts")
  assert.equal(method.method.type, "key")
  assert.match(method.method.label, /SK/)
  assert.equal(method.method.form[0].key, "ak")
  assert.equal(method.method.form[0].required, true)

  const vision = recorded.tools.find((tool) => tool.name === "codearts_vision")
  assert.ok(vision, "vision tool registered by default")
  assert.equal(vision.input.type, "object")
  assert.ok(vision.input.properties.image)
  await assert.rejects(
    () => vision.execute({ prompt: "hi" }),
    /connect|AK\/SK/i,
    "execute without credentials yields the connect hint",
  )
})

test("V2 setup: visionTool:false skips the tool transform", async () => {
  const mod = await import("../dist/index.js?v2-notool")
  const { ctx, recorded } = makeV2Context({ visionTool: false })
  const cleanup = await mod.default.setup(ctx)
  cleanup()
  assert.equal(recorded.tools.length, 0)
})

process.on("unhandledRejection", (e) => {
  console.error("unhandledRejection", e)
  process.exit(1)
})
