import { createSignedFetch } from "./signer.js"

const DEFAULT_BASE = "https://snap-access.cn-north-4.myhuaweicloud.com"
const FALLBACK_MODELS = [
  {
    id: "GLM-5.2",
    name: "GLM-5.2",
    description: "CodeArts flagship coding model",
    context: 202752,
    output: 131072,
    reasoning: true,
    images: false,
  },
  {
    id: "Qwen3-VL-235B",
    name: "Qwen3-VL-235B",
    description: "Qwen3 multimodal model",
    context: 131072,
    output: 32768,
    reasoning: false,
    images: true,
  },
]

function toModel(m) {
  return {
    id: m.id,
    providerID: "codearts",
    name: m.name ?? m.id,
    family: "codearts",
    api: {
      id: m.id,
      url: m.apiUrl ?? DEFAULT_BASE + "/api/v2",
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

export function pickAgentId(agents) {
  const list = agents?.agents ?? agents?.items ?? (Array.isArray(agents) ? agents : [])
  for (const a of list) {
    const clients = a.supported_clients ?? a.supportedClients ?? []
    const name = (a.app_name || a.agent_name || a.alias?.alias_en_us || a.alias?.alias_zh_cn || "").toString()
    if (clients.some((c) => String(c).toUpperCase() === "CLI") || name === "CodeAgent" || a.is_primary_agent) {
      if (a.agent_id) return a.agent_id
    }
  }
  for (const a of list) if (a.agent_id) return a.agent_id
  return undefined
}

export async function discoverModels(ak, sk, base = DEFAULT_BASE) {
  const doFetch = createSignedFetch(ak, sk)
  const agentListUrl = `${base}/v1/agent-center/agents/useragents?offset=0&limit=100`
  const listRes = await doFetch(agentListUrl, {
    method: "GET",
    headers: { "Content-Type": "application/json", "X-Language": "zh-cn", "Agent-Type": "AgentCenter" },
  })
  if (!listRes.ok) throw new Error(`agent list failed: HTTP ${listRes.status} ${await listRes.text()}`)
  const listJson = await listRes.json()
  const agentId = pickAgentId(listJson)
  if (!agentId) throw new Error("no agent_id found in useragents response")

  const detailRes = await doFetch(`${base}/v1/agent-center/agents/detail?agent_id=${agentId}`, {
    method: "GET",
    headers: { "Content-Type": "application/json", "X-Language": "zh-cn", "Agent-Type": "AgentCenter" },
  })
  if (!detailRes.ok) throw new Error(`agent detail failed: HTTP ${detailRes.status} ${await detailRes.text()}`)
  const detail = await detailRes.json()

  const gpts = detail.gpts?.models ?? []
  const models = gpts
    .filter((m) => m.model_parameters?.display_enabled !== false)
    .map((m) => {
      const p = m.model_parameters ?? {}
      return {
        id: m.model_name,
        name: m.model_alias ?? m.model_name,
        description: p.model_desc_en ?? p.model_desc ?? "",
        context: p.context_window ?? p.truncate_length ?? 131072,
        output: p.max_tokens ?? 32768,
        reasoning: p.thinking_type != null && p.thinking_type !== "" && p.thinking_type !== 0,
        images: Boolean(p.supports_images),
        apiUrl: base + "/api/v2",
      }
    })
  return models.length > 0 ? models : FALLBACK_MODELS
}
