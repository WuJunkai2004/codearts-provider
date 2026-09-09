# opencode-codearts-provider

OpenCode 插件：将华为云 CodeArts（snap-access InferHub）模型接入 opencode。

## 工作原理

- 复刻 CodeArts CLI（agentkernel）的请求签名：华为云 APIG `SDK-HMAC-SHA256`
- 动态模型发现：`/v1/agent-center/agents/useragents` → `/v1/agent-center/agents/detail`（与官方 CLI 相同的链路，`Agent-Type: AgentCenter` 头 + AK/SK 签名）
- 推理端点：`POST {base}/api/v2/chat/completions`（OpenAI 兼容，`@ai-sdk/openai-compatible`）
- 通过插件 `config` hook 注入 `options.fetch` 签名函数：每个请求（含流式）都会计算 body SHA256 并替换 Authorization 头

## 安装

### 方式一：测试安装法（本地开发，全局生效）

在全局配置 `~/.config/opencode/opencode.jsonc` 的 `plugin` 数组中添加本地包目录的 `file://` 路径：

```jsonc
{
  "plugin": ["file:///D:/code/huaweicode/codearts-provider"]
}
```

opencode 会读取包的 `exports["./server"]`（`dist/index.js`），无需发布 npm。

### 方式二：发布为 npm 包后

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-codearts-provider"]
}
```

2. 设置凭证（环境变量方式）：

```
CODEARTS_CLI_AK=<你的AK>
CODEARTS_CLI_SK=<你的SK>
```

或者用 `/connect` 命令，选择 "Huawei CodeArts AK/SK"，输入 `AK/SK`（用 `/` 分隔）。

## 使用

```
opencode models                 # 查看发现的模型（codearts/GLM-5.2 等）
opencode run -m codearts/GLM-5.2 "hello"
```

## 配置项

在 plugin 数组中用元组形式传入（可选）：

```jsonc
"plugin": [["file:///D:/code/huaweicode/codearts-provider", { "baseURL": "https://snap-access.cn-north-4.myhuaweicloud.com", "ak": "...", "sk": "..." }]]
```

| 选项 | 默认值 | 说明 |
|---|---|---|
| `baseURL` | `https://snap-access.cn-north-4.myhuaweicloud.com` | 服务 base URL |
| `ak` / `sk` | 环境变量 `CODEARTS_CLI_AK/SK` | 凭证（优先级：options > env） |

## 测试

```
npm test        # node --test（签名向量 + mock 发现流程）
```

## 请求构建算法（Python 参考实现）

以下用 Python 完整描述对 CodeArts InferHub 发起请求所需的全部算法。整个插件做的事等价于：**对每个出站 HTTP 请求，按华为云 APIG 规范计算 `SDK-HMAC-SHA256` 签名头，替换 SDK 自动生成的 `Authorization`**。

### 1. 签名算法（SDK-HMAC-SHA256）

```python
import datetime, hashlib, hmac, urllib.parse

def sdk_date():
    # UTC 时间戳，格式 20260909T123456Z
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")

def rfc3986(s):
    # URI 编码（保留 -_.~），与 JS 端 encodeURIComponent 行为一致
    return urllib.parse.quote(str(s), safe="-_.~")

def sign_request(method, url, ak, sk, headers=None, body=b""):
    """计算华为云 APIG SDK-HMAC-SHA256 签名，返回需附加的请求头。"""
    u = urllib.parse.urlparse(url)
    headers = dict(headers or {})

    # --- CanonicalQuery：query 参数按 key 排序，key/value 均 RFC3986 编码 ---
    q = sorted(
        (rfc3986(k), rfc3986(v))
        for k, v in urllib.parse.parse_qsl(u.query, keep_blank_values=True)
    )
    canonical_query = "&".join(f"{k}={v}" for k, v in q)

    # --- CanonicalURI：路径解码后，末尾必须补斜杠（华为云特有规则！）---
    #   /api/v2/chat/completions  ->  /api/v2/chat/completions/
    canonical_path = urllib.parse.unquote(u.path) or "/"
    if not canonical_path.endswith("/"):
        canonical_path += "/"

    # --- CanonicalHeaders：参与签名的头（小写）+ host + x-sdk-date ---
    h = {k.lower(): str(v).strip() for k, v in headers.items()}
    h["host"] = u.netloc
    h["x-sdk-date"] = sdk_date()
    names = sorted(h)                                     # 头名按字典序
    canonical_headers = "".join(f"{n}:{h[n]}\n" for n in names)
    signed_headers = ";".join(names)

    # --- CanonicalRequest ---
    payload = body if isinstance(body, bytes) else body.encode()
    canonical_request = "\n".join([
        method.upper(),                                   # 1. HTTP 方法
        canonical_path,                                   # 2. 规范化 URI（带尾斜杠）
        canonical_query,                                  # 3. 规范化 query
        canonical_headers,                                # 4. 规范化头（每行以 \n 结尾）
        signed_headers,                                   # 5. 参与签名的头名列表
        hashlib.sha256(payload).hexdigest(),              # 6. 请求体 SHA256（十六进制）
    ])

    # --- StringToSign ---
    string_to_sign = "\n".join([
        "SDK-HMAC-SHA256",                                # 固定算法名
        h["x-sdk-date"],                                  # 时间戳
        hashlib.sha256(canonical_request.encode()).hexdigest(),
    ])

    # --- Signature：HMAC-SHA256(SK, StringToSign) ---
    signature = hmac.new(sk.encode(), string_to_sign.encode(), hashlib.sha256).hexdigest()

    return {
        **headers,
        "X-Sdk-Date": h["x-sdk-date"],
        "Authorization": (
            f"SDK-HMAC-SHA256 Access={ak}, "
            f"SignedHeaders={signed_headers}, "
            f"Signature={signature}"
        ),
    }
```

要点：

- **尾斜杠规则**：`/v1/sessions` 签名时按 `/v1/sessions/` 计算，但实际请求路径不变。漏掉这条必然 401。
- **body 哈希**：签名覆盖请求体，所以必须在发送前完成序列化（流式请求同理，SSE 响应不受影响）。
- **替换 Authorization**：OpenAI 兼容 SDK 会自带 `Authorization: Bearer <apiKey>`，签名后必须**删掉**这个头只保留华为签名头，否则网关按 IAM token 解析报 `APIG.0301 decrypt token fail`。

### 2. 签名请求发送

```python
import json, urllib.request, urllib.error

def request(method, url, body=None, headers=None, ak=AK, sk=SK, timeout=180):
    headers = dict(headers or {})
    headers.setdefault("User-Agent", "codearts-cli")
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        headers.setdefault("Content-Type", "application/json")
    # 对完整请求（含 body）计算签名
    signed = sign_request(method, url, ak, sk, headers, data or b"")
    req = urllib.request.Request(url, data=data, method=method.upper(), headers=signed)
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} {url}: {e.read().decode('utf-8', 'replace')[:400]}") from e
```

### 3. 模型发现（agent-center 链路）

```python
import json

BASE = "https://snap-access.cn-north-4.myhuaweicloud.com"

# 步骤 1：列出账号可用 agent（CLI 客户端找 supported_clients 含 CLI 的，
#          找不到则退回 CodeAgent / is_primary_agent / 第一个）
r = request("GET", BASE + "/v1/agent-center/agents/useragents?offset=0&limit=100",
            None, {"X-Language": "zh-cn", "Agent-Type": "AgentCenter"})
agents = json.loads(r.read())["agents"]          # 17 个
agent_id = next(a["agent_id"] for a in agents
                if "CLI" in (a.get("supported_clients") or []))

# 步骤 2：拉取 agent 详情，gpts.models 即模型清单
r = request("GET", BASE + f"/v1/agent-center/agents/detail?agent_id={agent_id}",
            None, {"X-Language": "zh-cn", "Agent-Type": "AgentCenter"})
detail = json.loads(r.read())

for m in detail["gpts"]["models"]:
    p = m["model_parameters"]
    print(m["model_name"],                     # 模型 ID（请求体 model 字段）
          p.get("context_window"),             # 上下文窗口
          p.get("max_tokens"),                 # 最大输出
          p.get("supports_images"),            # 多模态
          p.get("thinking_type"))              # 推理能力标记
```

注意 `Agent-Type: AgentCenter` 头是**必需**的：缺失报"请求头Agent-Type为空"，错值报 TM.00001001 路由错误。

### 4. 对话（含流式）

```python
def chat(model, messages, stream=True):
    body = {"model": model, "messages": messages, "stream": stream}
    r = request("POST", BASE + "/api/v2/chat/completions", body, {"X-Language": "zh-cn"})
    if not stream:
        return json.loads(r.read())["choices"][0]["message"]["content"]
    # SSE 流式解析
    parts = []
    for raw in r:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            delta = json.loads(data)["choices"][0]["delta"].get("content") or ""
        except (KeyError, IndexError, json.JSONDecodeError):
            continue
        if delta:
            print(delta, end="", flush=True)
            parts.append(delta)
    return "".join(parts)

# 文本
chat("GLM-5.2", [{"role": "user", "content": "hi"}])

# 多模态（仅 Qwen3-VL-235B 等视觉模型支持）
chat("Qwen3-VL-235B", [{"role": "user", "content": [
    {"type": "text", "text": "What color is this image?"},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,<BASE64>"}},
]}])
```

### 5. 端点与模型清单

| 端点 | 用途 |
|---|---|
| `POST /api/v2/chat/completions` | 对话（OpenAI 兼容，支持 SSE 流式） |
| `GET /v1/agent-center/agents/useragents` | agent 列表（需 `Agent-Type: AgentCenter`） |
| `GET /v1/agent-center/agents/detail?agent_id=` | agent 详情（含模型清单） |
| `POST /v1/sessions` | 会话注册（客户端心跳类） |

模型（2026-09 实测）：

| 模型 | 来源 | 文本 | 工具调用 | 图片 |
|---|---|---|---|---|
| `GLM-5.2` | agent-center 下发 | ✅ | ✅ | ❌ 406 |
| `GLM-5.2-ArkTS-SPARK` | agent-center 下发 | ❌ 404 | ❌ | ❌ |
| `OpenPangu-2.0-Pro/Flash` | agent-center 下发 | ❌ 404 | ❌ | ❌ |
| `Qwen3-VL-235B` | 二进制硬编码 | ✅ | ❌ 400（vLLM 未开 `--enable-auto-tool-choice`） | ✅ |
| `Qwen3.6-27B-VL` / `Qwen3.5-397B-A17B-VL` / `Qwen3-Coder-30B-A3B-Instruct` / `ClaudeV1` | 二进制硬编码 | ❌ 404 | ❌ | ❌ |

## 文件结构

```
src/index.ts      # 插件入口：V1 形态 default export { id, server }（config/provider/auth hooks）
src/signer.ts     # SDK-HMAC-SHA256 签名 + 签名 fetch
src/discover.ts   # agent-center 模型发现
dist/             # tsc 构建产物（exports["./server"] 指向 dist/index.js）
test/plugin.test.js
test/live-check.js # 真实 API 冒烟测试（需环境变量）
```

## 开发

```
npm install
npm run build      # tsc -> dist
npm run typecheck
npm test
```
