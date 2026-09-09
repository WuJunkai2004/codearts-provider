import { test } from "node:test"
import assert from "node:assert/strict"
import { signRequest, sdkDate, createSignedFetch } from "../dist/signer.js"
import { discoverModels, pickAgentId } from "../dist/discover.js"

const AK = "TESTAK"
const SK = "TESTSK"

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

test("with env credentials provider is registered with discovered + extra models", async (t) => {
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
  assert.ok(names.includes("GLM-5.2"), "discovered model present")
  assert.ok(names.includes("Qwen3-VL-235B"), "extra static model present")
  assert.ok(names.includes("OpenPangu-2.0-Pro") === false, "only mocked discovery results")

  const models = await hooks.provider.models({ options: { baseURL: "https://example.com/api/v2" } }, { auth: undefined })
  assert.equal(models["Qwen3-VL-235B"].capabilities.input.image, true, "VL model marked multimodal")
  assert.equal(models["GLM-5.2"].capabilities.input.image, false, "GLM not multimodal")
})

process.on("unhandledRejection", (e) => {
  console.error("unhandledRejection", e)
  process.exit(1)
})
