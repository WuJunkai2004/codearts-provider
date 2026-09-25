import { createSignedFetch } from "./signer.js";
import { OPENGW_BASE } from "./constants.js";

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
  /** true if discovered via the opengw gateway — inference needs
   * `maas_type: benefit` (registry in opengw.ts, applied in signer.ts). */
  opengw?: boolean;
};

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
  const models = await discoverAgentCenter(ak, sk, base);
  // Merge models from the opengw gateway (IDE-exclusive models like
  // deepseek-v4, glm-5.3). Discovery uses the same AK/SK; inference for
  // these models requires a `maas_type: benefit` header (see opengw.ts).
  try {
    for (const m of await discoverOpengw(ak, sk)) {
      if (!models.some((x) => x.id === m.id)) models.push(m);
    }
  } catch (e) {
    console.error(
      "[codearts-provider] opengw model discovery failed:",
      (e as Error)?.message ?? e,
    );
  }
  return models;
}

/** Primary source: the agent-center model list on the snap-access gateway
 * (`useragents` → `pickAgentId` → `detail`, requires the `Agent-Type:
 * AgentCenter` header). Fails fast — any error propagates to the caller. */
async function discoverAgentCenter(
  ak: string,
  sk: string,
  base: string,
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
  const models: DiscoveredModel[] = gpts
    .filter((m) => m.model_parameters?.display_enabled !== false)
    .map((m) => {
      const p = m.model_parameters ?? {};
      return {
        // model_alias is the routing ID sent in the chat/completions body
        // (captured from the real CLI: "model":"openpangu-2.0-pro");
        // model_name is the display name (e.g. "OpenPangu-2.0-Pro").
        id: m.model_alias ?? m.model_name,
        name: m.model_name,
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
  return models;
}

/** Discover models from the opengw gateway (IDE-exclusive models).
 * Uses the same AK/SK signing as snap-access. The returned models carry
 * `opengw: true`; models.ts registers them in the opengw.ts registry so
 * signer.ts adds `maas_type: benefit` on inference.
 * Best-effort: failures are caught by the caller. */
async function discoverOpengw(
  ak: string,
  sk: string,
): Promise<DiscoveredModel[]> {
  const doFetch = createSignedFetch(ak, sk);
  const url = `${OPENGW_BASE}/api/v1/gateway/config`;
  const res = await doFetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok)
    throw new Error(
      `opengw config failed: HTTP ${res.status} ${await res.text()}`,
    );
  const json = await res.json();
  const models: Array<{
    model_id: string;
    model_name?: string;
    context_window?: number;
    max_tokens?: number;
  }> = json?.result?.models ?? [];
  return models.map((m) => ({
    id: m.model_id,
    name: m.model_name ?? m.model_id,
    context: m.context_window ?? 131072,
    output: m.max_tokens ?? 32768,
    reasoning: false,
    images: false,
    apiUrl: DEFAULT_BASE + "/api/v2",
    opengw: true,
  }));
}
