import { signRequest } from "../dist/signer.js";

const AK = process.env.CODEARTS_CLI_AK;
const SK = process.env.CODEARTS_CLI_SK;
const BASE = "https://snap-access.cn-north-4.myhuaweicloud.com";

const headers = signRequest(
  "GET",
  `${BASE}/v1/agent-center/agents/useragents?offset=0&limit=100`,
  AK,
  SK,
  {
    "Content-Type": "application/json",
    "X-Language": "zh-cn",
    "Agent-Type": "AgentCenter",
  },
);

const res = await fetch(
  `${BASE}/v1/agent-center/agents/useragents?offset=0&limit=100`,
  { headers },
);
console.log("status:", res.status);
const text = await res.text();
console.log(text.slice(0, 200));
