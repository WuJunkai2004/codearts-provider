import { createSignedFetch } from "./signer.js";

export const DEFAULT_BASE = "https://snap-access.cn-north-4.myhuaweicloud.com";

export type DiscoveredModel = {
  id: string;
  name: string;
  description?: string;
  context?: number;
  output?: number;
  reasoning?: boolean;
  images?: boolean;
  apiUrl?: string;
};

const FALLBACK_MODELS: DiscoveredModel[] = [
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
];

type AgentEntry = {
  agent_id?: string;
  supported_clients?: string[];
  supportedClients?: string[];
  app_name?: string;
  agent_name?: string;
  alias?: { alias_en_us?: string; alias_zh_cn?: string };
  is_primary_agent?: boolean;
};

type AgentsResponse = {
  agents?: AgentEntry[];
  items?: AgentEntry[];
};

export function pickAgentId(
  agents: AgentsResponse | AgentEntry[] | undefined,
): string | undefined {
  const list =
    (agents as AgentsResponse | undefined)?.agents ??
    (agents as AgentsResponse | undefined)?.items ??
    (Array.isArray(agents) ? agents : []);
  for (const a of list) {
    const clients = a.supported_clients ?? a.supportedClients ?? [];
    const name = (
      a.app_name ||
      a.agent_name ||
      a.alias?.alias_en_us ||
      a.alias?.alias_zh_cn ||
      ""
    ).toString();
    if (
      clients.some((c) => String(c).toUpperCase() === "CLI") ||
      name === "CodeAgent" ||
      a.is_primary_agent
    ) {
      if (a.agent_id) return a.agent_id;
    }
  }
  for (const a of list) if (a.agent_id) return a.agent_id;
  return undefined;
}

export async function discoverModels(
  ak: string,
  sk: string,
  base: string = DEFAULT_BASE,
): Promise<DiscoveredModel[]> {
  const doFetch = createSignedFetch(ak, sk);
  const agentListUrl = `${base}/v1/agent-center/agents/useragents?offset=0&limit=100`;
  const listRes = await doFetch(agentListUrl, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Language": "zh-cn",
      "Agent-Type": "AgentCenter",
    },
  });
  if (!listRes.ok)
    throw new Error(
      `agent list failed: HTTP ${listRes.status} ${await listRes.text()}`,
    );
  const listJson: AgentsResponse = await listRes.json();
  const agentId = pickAgentId(listJson);
  if (!agentId) throw new Error("no agent_id found in useragents response");

  const detailRes = await doFetch(
    `${base}/v1/agent-center/agents/detail?agent_id=${agentId}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Language": "zh-cn",
        "Agent-Type": "AgentCenter",
      },
    },
  );
  if (!detailRes.ok)
    throw new Error(
      `agent detail failed: HTTP ${detailRes.status} ${await detailRes.text()}`,
    );
  const detail = await detailRes.json();

  const gpts: Array<{
    model_name: string;
    model_alias?: string;
    model_parameters?: {
      display_enabled?: boolean;
      model_desc_en?: string;
      model_desc?: string;
      context_window?: number;
      truncate_length?: number;
      max_tokens?: number;
      thinking_type?: string | number;
      supports_images?: boolean;
    };
  }> = detail.gpts?.models ?? [];
  const models = gpts
    .filter((m) => m.model_parameters?.display_enabled !== false)
    .map((m) => {
      const p = m.model_parameters ?? {};
      return {
        id: m.model_name,
        name: m.model_alias ?? m.model_name,
        description: p.model_desc_en ?? p.model_desc ?? "",
        context: p.context_window ?? p.truncate_length ?? 131072,
        output: p.max_tokens ?? 32768,
        reasoning:
          p.thinking_type != null &&
          p.thinking_type !== "" &&
          p.thinking_type !== 0,
        images: Boolean(p.supports_images),
        apiUrl: base + "/api/v2",
      };
    });
  return models.length > 0 ? models : FALLBACK_MODELS;
}
