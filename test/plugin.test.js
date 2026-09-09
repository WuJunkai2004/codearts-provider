import { test } from "node:test"
import assert from "node:assert/strict"
import { signRequest, sdkDate, createSignedFetch } from "../src/signer.js"
import { discoverModels, pickAgentId } from "../src/discover.js"

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
  const mod = await import("../src/index.js")
  assert.equal(mod.default.id, "opencode-codearts-provider")
  assert.equal(typeof mod.default.server, "function")
})

test("server() returns hooks; provider NOT registered without credentials", async (t) => {
  const savedAk = process.env.CODEARTS_CLI_AK
  const savedSk = process.env.CODEARTS_CLI_SK
  delete process.env.CODEARTS_CLI_AK
  delete process.env.CODEARTS_CLI_SK
  t.after(() => {
    if (savedAk !== undefined) process.env.CODEARTS_CLI_AK = savedAk
    if (savedSk !== undefined) process.env.CODEARTS_CLI_SK = savedSk
  })

  const mod = await import("../src/index.js?no-creds")
  const hooks = await mod.default.server({ client: {}, project: {}, directory: ".", worktree: ".", $: {} } as never, {})
  assert.ok(hooks.config, "config hook")
  assert.equal(hooks.provider.id, "codearts")
  assert.equal(typeof hooks.provider.models, "function")
  assert.equal(hooks.auth.provider, "codearts")

  const cfg = {}
  await hooks.config(cfg)
  assert.equal(cfg.provider.codearts, undefined, "provider NOT registered without credentials")

  const models = await hooks.provider.models(
    { options: { baseURL: "https://example.com/api/v2" } },
    { auth: undefined },
  )
  // no creds -> no models
  assert.deepEqual(Object.keys(models), [])

  // auth loader: ak/sk key -> signed fetch + placeholder apiKey
  const opts = await hooks.auth.loader(async () => ({ type: "api", key: "MYAK/MYSK" }))
  assert.equal(opts.apiKey, "codearts-signed")
  assert.equal(typeof opts.fetch, "function")
})

test("auth loader: plain AK with metadata.sk", async () => {
  const mod = await import("../src/index.js?meta-sk")
  const hooks = await mod.default.server({} as never, {})
  const opts = await hooks.auth.loader(async () => ({
    type: "api",
    key: "MYAK",
    metadata: { sk: "MYSK" },
  }))
  assert.equal(typeof opts.fetch, "function")
})

test("auth loader: no auth -> empty options", async () => {
  const mod = await import("../src/index.js?no-auth")
  const hooks = await mod.default.server({} as never, {})
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

  const mod = await import("../src/index.js?with-creds")
  const hooks = await mod.default.server({} as never, {})
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
