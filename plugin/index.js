import { createSignedFetch } from "./signer.js"
import { discoverModels } from "./discover.js"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PROVIDER_ID = "codearts"
const DEFAULT_BASE = "https://snap-access.cn-north-4.myhuaweicloud.com"

const getEnv = (name) => process.env[name]

// Reads AK/SK from opencode's /connect credential store
// (~/.local/share/opencode/auth.json, key format "AK/SK").
let storedAuthCache
function readStoredAuth() {
  if (storedAuthCache !== undefined) return storedAuthCache
  let result = null
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8"))
    const entry = raw?.[PROVIDER_ID]
    if (entry?.type === "api" && typeof entry.key === "string" && entry.key.includes("/")) {
      const [ak, sk] = entry.key.split("/")
      if (ak && sk) result = { ak, sk }
    }
  } catch {
    // no stored credential
  }
  if (result) storedAuthCache = result
  return result
}

function resolveCreds(opts = {}, pluginOptions = {}) {
  const ak = opts.ak ?? pluginOptions.ak ?? getEnv("CODEARTS_CLI_AK")
  const sk = opts.sk ?? pluginOptions.sk ?? getEnv("CODEARTS_CLI_SK")
  if (ak && sk) return { ak, sk }
  return readStoredAuth()
}

function resolveBase(opts = {}, pluginOptions = {}) {
  const raw = opts.baseURL ?? pluginOptions.baseURL ?? DEFAULT_BASE
  return String(raw).replace(/\/api\/v2\/?$/, "").replace(/\/$/, "")
}

// Models known from the CodeArts CLI binary (agentkernel) that are NOT served
// through the agent-center API. Merged into the discovered set as a supplement;
// the gateway may or may not route them for a given account.
const EXTRA_MODELS = [
  { id: "GLM-5.2", name: "GLM-5.2", context: 202752, output: 131072, reasoning: true, images: false },
  { id: "Qwen3-VL-235B", name: "Qwen3-VL-235B", context: 131072, output: 32768, reasoning: false, images: true },
  { id: "Qwen3.6-27B-VL", name: "Qwen3.6-27B-VL", context: 131072, output: 32768, reasoning: false, images: true },
  { id: "Qwen3.5-397B-A17B-VL", name: "Qwen3.5-397B-A17B-VL", context: 131072, output: 32768, reasoning: false, images: true },
  { id: "Qwen3-Coder-30B-A3B-Instruct", name: "Qwen3-Coder-30B-A3B", context: 131072, output: 32768, reasoning: false, images: false },
  { id: "ClaudeV1", name: "ClaudeV1", context: 200000, output: 65536, reasoning: true, images: false },
]

function toModel(m, base) {
  return {
    id: m.id,
    providerID: PROVIDER_ID,
    name: m.name ?? m.id,
    family: "codearts",
    api: {
      id: m.id,
      url: `${base}/api/v2`,
      npm: "@ai-sdk/openai-compatible",
    },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 131072, output: m.output ?? 32768 },
    capabilities: {
      temperature: true,
      reasoning: Boolean(m.reasoning),
      attachment: Boolean(m.images),
      toolcall: true,
      input: { text: true, audio: false, image: Boolean(m.images), video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

function toConfigModel(m) {
  const cfg = {
    name: m.name ?? m.id,
    limit: { context: m.context ?? 131072, output: m.output ?? 32768 },
    tool_call: true,
  }
  if (m.reasoning) cfg.reasoning = true
  if (m.images) cfg.attachment = true
  return cfg
}

async function fetchModels(opts, pluginOptions) {
  const base = resolveBase(opts, pluginOptions)
  const creds = resolveCreds(opts, pluginOptions)
  if (!creds) return { base, models: null, creds: null }
  try {
    const discovered = await discoverModels(creds.ak, creds.sk, base)
    // discovered models win; extras supplement without overriding
    const seen = new Set(discovered.map((m) => m.id))
    const models = [...discovered, ...EXTRA_MODELS.filter((m) => !seen.has(m.id))]
    return { base, models, creds }
  } catch (e) {
    console.error("[codearts-provider] model discovery failed, using extras only:", e?.message ?? e)
    return { base, models: EXTRA_MODELS, creds }
  }
}

export default async function codeartsPlugin(input, pluginOptions = {}) {
  return {
    // Runs before opencode reads cfg.provider. Without credentials (no env
    // vars, no /connect entry) the provider is not registered at all.
    config: async (config) => {
      config.provider = config.provider ?? {}
      const { base, models, creds } = await fetchModels({}, pluginOptions)
      if (!creds || !models) return
      const modelEntries = {}
      for (const m of models) modelEntries[m.id] = toConfigModel(m)

      const existing = config.provider[PROVIDER_ID]
      const target = existing ?? {}
      target.name = target.name ?? "Huawei CodeArts"
      target.npm = target.npm ?? "@ai-sdk/openai-compatible"
      target.options = target.options ?? {}
      target.options.baseURL = target.options.baseURL ?? `${base}/api/v2`
      if (!target.options.fetch) {
        // placeholder apiKey: the OpenAI-compatible SDK insists on one, but the
        // signed Authorization header produced by options.fetch wins on the wire
        target.options.apiKey = target.options.apiKey ?? "codearts-signed"
        target.options.fetch = createSignedFetch(creds.ak, creds.sk)
      }
      if (!existing || Object.keys(target.models ?? {}).length === 0) target.models = modelEntries
      config.provider[PROVIDER_ID] = target
    },

    // Dynamic model refresh for sessions where the provider is already in the
    // database (e.g. listed in models.dev).
    provider: {
      id: PROVIDER_ID,
      models: async (provider) => {
        const opts = provider?.options ?? {}
        const { base, models } = await fetchModels(opts, pluginOptions)
        const out = {}
        if (!models) return out
        for (const m of models) out[m.id] = toModel(m, base)
        return out
      },
    },

    // Turns a stored /connect credential ("ak/sk" or plain AK with SK in
    // metadata) into provider options: placeholder apiKey plus the signed
    // fetch injected via options.fetch.
    auth: {
      provider: PROVIDER_ID,
      loader: async (getAuth) => {
        const auth = await getAuth()
        const opts = {}
        let ak, sk
        if (auth?.type === "api") {
          const key = auth.key ?? ""
          if (key.includes("/")) {
            ;[ak, sk] = key.split("/")
          } else {
            ak = key
            sk = auth.metadata?.sk
          }
        }
        if (!ak || !sk) return opts
        opts.apiKey = "codearts-signed"
        opts.fetch = createSignedFetch(ak, sk)
        return opts
      },
      methods: [
        {
          type: "api",
          label: "Huawei CodeArts AK/SK (format: AK/SK)",
          prompts: [
            {
              type: "text",
              key: "key",
              message: "Enter CODEARTS AK/SK (separated by /)",
              placeholder: "HPUA.../zjnh...",
            },
          ],
        },
      ],
    },
  }
}
