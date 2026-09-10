# opencode-codearts-provider

OpenCode 插件：将华为云 CodeArts（snap-access InferHub）模型接入 opencode。

## 工作原理

- 复刻 CodeArts CLI（agentkernel）的请求签名：华为云 APIG `SDK-HMAC-SHA256`
- 动态模型发现：`/v1/agent-center/agents/useragents` → `/v1/agent-center/agents/detail`（与官方 CLI 相同的链路，`Agent-Type: AgentCenter` 头 + AK/SK 签名）
- **模型 ID = `model_alias`（小写路由别名），显示名 = `model_name`**。例如显示名 `OpenPangu-2.0-Pro` 的路由 ID 是 `openpangu-2.0-pro`，直接用 `model_name` 请求会报 `InferHub.002002009 not registered`（GLM-5.2 恰好别名=名字，因此曾误判为"只有 GLM 能用"）
- 推理端点：`POST {base}/api/v2/chat/completions`（OpenAI 兼容，`@ai-sdk/openai-compatible`）
- 通过插件 `config` / `auth` hook 注入 `options.fetch` 签名函数：每个请求（含流式）都会计算 body SHA256 并替换 Authorization 头
- **chat 请求自动补全 CLI 请求形态**（网关按请求形态路由，详见[网关路由规则](#网关路由规则gateway-routing)）：完整 CLI 头集（`x-ot-*`、`user-session-id`、`model-id` 等）+ CLI User-Agent + body 补 `stream` / `tool_stream` / `user_prompt` 字段
- 3 个 hook：`config`（启动注册 provider + 注入签名 fetch）、`provider`（动态模型刷新）、`auth`（/connect 凭据流）

## 安装

### 方式一：本地开发（全局生效）

先构建，再在全局配置 `~/.config/opencode/opencode.jsonc` 的 `plugin` 数组中添加本地包目录的 `file://` 路径：

```
npm install
npm run build        # 生成 dist/（opencode 加载的就是 dist/index.js）
```

```jsonc
{
  "plugin": ["file:///.../codearts-provider"]
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

## 凭证

环境变量方式：

```
CODEARTS_CLI_AK=<你的AK>
CODEARTS_CLI_SK=<你的SK>
```

或用 `/connect` 命令选择 Huawei CodeArts，**两步输入**：第 1 步输入 AK（自定义提示页），第 2 步输入 SK（内置 API key 页）。存储格式：`auth.json` 中 `key` = SK、`metadata.ak` = AK。

优先级链：`provider options` > `plugin options` > 环境变量 `CODEARTS_CLI_AK/SK` > `/connect` 存储的凭证。

**无凭证行为**：provider 始终注册（保证 /connect 里能看到），但模型列表只有一个占位模型 `connect-required`，名称显示"未连接 — 请使用 /connect 添加华为云 CodeArts AK/SK"，不发出任何推理请求。

## 使用

```
opencode models                                  # 5 个模型
opencode run -m codearts/openpangu-2.0-pro "hello"
opencode run -m codearts/GLM-5.2 "hello"
```

## 模型清单（2026-09 实测）

| 模型 ID（= model_alias） | 显示名（model_name） | 来源 | 文本 | 图片 |
|---|---|---|---|---|
| `openpangu-2.0-pro` | OpenPangu-2.0-Pro | agent-center 下发 | ✅ | ❌ |
| `openpangu-2.0-flash` | OpenPangu-2.0-Flash | agent-center 下发 | ✅ | ❌ |
| `GLM-5.2` | GLM-5.2 | agent-center 下发 | ✅ | ❌（实测 406） |
| `glm-5.2-sft-harmony` | GLM-5.2-ArkTS-SPARK | agent-center 下发 | ✅ | ❌ |
| `Qwen3-VL-235B` | Qwen3-VL-235B | EXTRA_MODELS 硬编码 | ✅ | ✅ |

以下模型网关可路由但**该账号未注册**（`InferHub.002002009 not registered`），已从插件剔除：`Qwen3.6-27B-VL`、`Qwen3.5-397B-A17B-VL`、`Qwen3-Coder-30B-A3B-Instruct`、`ClaudeV1`。用 `model_name`（显示名）请求 Pangu/ArkTS 同样报 not registered——必须用别名。

## 网关路由规则（gateway routing）

snap-access 网关**按请求形态路由**，chat 请求缺任何一项都会落到错误后端（Whitelabel 404 / not registered）：

1. **User-Agent** 必须是 CLI 的：`ai-sdk/provider-utils/4.0.21 runtime/bun/1.3.14`（Node 默认 UA → Whitelabel 404）。注意 SDK 会传小写 `user-agent` 头，与注入的 `User-Agent` 在 JS 对象中大小写不同会共存成两条头、签名只含一条 → `APIG.0301 verify ak sk signature fail`。signer 对 chat 头做了大小写不敏感合并（后者覆盖前者）
2. **完整 CLI 头集**：`x-ot-trace-id` / `x-ot-span-id` / `x-snap-traceid`（`32hex_16hex`）/ `x-ot-session-id` / `x-ot-parent-session-id`（空）/ `user-session-id` / `x-ot-function: agent-tui` / `X-Language` / `user-msg-id` / `created-time` / `x-ot-client-type: CLI` / `x-ot-client-version` / `client-ip` / `X-Security-token`（空）/ `model-id` / `model-name`（均填路由别名）
3. **body 字段**：`stream: true`、`tool_stream: true`、`user_prompt`（最后一条用户消息文本）

注意：

- **`user-session-id` 语义**：服务端按它计数会话，上限 3 个并发（`TM.00001041 并发会话数已达上限`，约 60-75 秒后释放）。插件按 `createSignedFetch` 实例生成一次、进程内不变——即一个 opencode 进程（含 `/new` 新开的对话）共用一个会话槽位，反而降低占用
- `/v1/sessions` 会话注册接口需要 `Agent-Type: PromptCenter` 头（AgentCenter/CodeBase 等报 TM.00001001）；CLI 启动时 POST 注册、每 120 秒心跳。插件未使用该接口，chat 直连即可

## 配置项

在 plugin 数组中用元组形式传入（可选）：

```jsonc
"plugin": [["file:///D:/code/huaweicode/codearts-provider", { "baseURL": "https://snap-access.cn-north-4.myhuaweicloud.com", "ak": "...", "sk": "..." }]]
```

| 选项 | 默认值 | 说明 |
|---|---|---|
| `baseURL` | `https://snap-access.cn-north-4.myhuaweicloud.com` | 服务 base URL |
| `ak` / `sk` | 环境变量 `CODEARTS_CLI_AK/SK` | 凭证（完整优先级链见[凭证](#凭证)） |

界面语言按 `CODEARTS_LANG` > `LC_ALL` > `LANG` 检测中文/英文（提示文案双语）。

## 测试

```
npm test        # node --test，20 个用例（签名向量、CLI 形态路由、mock 发现、i18n、/connect 两步流）
```

## 请求构建算法（Python 参考实现）

以下用 Python 完整描述对 CodeArts InferHub 发起请求所需的全部算法。整个插件做的事等价于：**对每个出站 HTTP 请求，按华为云 APIG 规范计算 `SDK-HMAC-SHA256` 签名头，替换 SDK 自动生成的 `Authorization`；chat 请求另需补全 CLI 请求形态**。

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
- **头大小写去重**：如果输入头里同时存在 `user-agent` 和 `User-Agent`（大小写不同的两个 key），HTTP 层会发两条、签名只含一条 → 验签失败。发送前按小写归一去重。

### 2. 签名请求发送

```python
import json, urllib.request, urllib.error

def request(method, url, body=None, headers=None, ak=AK, sk=SK, timeout=180):
    headers = dict(headers or {})
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

发现类接口（agent-center）用普通 User-Agent 即可；**chat 接口必须用下面的 CLI 头集**。

### 3. 模型发现（agent-center 链路）

```python
import json, uuid

BASE = "https://snap-access.cn-north-4.myhuaweicloud.com"

# 步骤 1：列出账号可用 agent（CLI 客户端找 supported_clients 含 CLI 的，
#          找不到则退回 CodeAgent / is_primary_agent / 第一个）
r = request("GET", BASE + "/v1/agent-center/agents/useragents?offset=0&limit=100",
            None, {"X-Language": "zh-cn", "Agent-Type": "AgentCenter"})
agents = json.loads(r.read())["agents"]
agent_id = next(a["agent_id"] for a in agents
                if "CLI" in (a.get("supported_clients") or []))

# 步骤 2：拉取 agent 详情，gpts.models 即模型清单
r = request("GET", BASE + f"/v1/agent-center/agents/detail?agent_id={agent_id}",
            None, {"X-Language": "zh-cn", "Agent-Type": "AgentCenter"})
detail = json.loads(r.read())

for m in detail["gpts"]["models"]:
    p = m.get("model_parameters") or {}
    print(m["model_alias"],                     # 路由 ID（请求体 model 字段用这个！）
          m["model_name"],                      # 显示名
          p.get("context_window"),              # 上下文窗口
          p.get("max_tokens"),                  # 最大输出
          p.get("supports_images"),             # 多模态
          p.get("thinking_type"))               # 推理能力标记
```

注意 `Agent-Type: AgentCenter` 头是**必需**的：缺失报"请求头Agent-Type为空"，错值报 TM.00001001 路由错误。

### 4. 对话（含流式，必须带 CLI 请求形态）

```python
import datetime

SESSION_ID = "ses_" + uuid.uuid4().hex[:26]     # 一个会话内保持不变

def cli_headers(model):
    """chat 请求必需的完整 CLI 头集（网关按形态路由）。"""
    return {
        "User-Agent": "ai-sdk/provider-utils/4.0.21 runtime/bun/1.3.14",
        "X-Security-token": "",
        "x-ot-trace-id": uuid.uuid4().hex,
        "x-ot-span-id": uuid.uuid4().hex,
        "x-snap-traceid": f"{uuid.uuid4().hex}_{uuid.uuid4().hex[:16]}",
        "x-ot-session-id": SESSION_ID,
        "x-ot-parent-session-id": "",
        "user-session-id": SESSION_ID,
        "x-ot-function": "agent-tui",
        "X-Language": "zh-cn",
        "user-msg-id": "msg_" + uuid.uuid4().hex[:24],
        "created-time": datetime.datetime.now(datetime.timezone.utc)
                        .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "x-ot-client-type": "CLI",
        "x-ot-client-version": "26.8.12",
        "client-ip": "198.18.0.1",              # CLI 发送本机出口 IP
        "model-id": model,                       # 路由别名，不是显示名
        "model-name": model,
    }

def chat(model, messages, stream=True):
    body = {
        "model": model,                          # 路由别名（model_alias）
        "messages": messages,
        "stream": True,                          # 必须为 true
        "tool_stream": True,
        "user_prompt": next((m["content"] for m in reversed(messages)
                             if m["role"] == "user"), ""),
    }
    r = request("POST", BASE + "/api/v2/chat/completions", body, cli_headers(model))
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

# 文本（注意用路由别名）
chat("openpangu-2.0-pro", [{"role": "user", "content": "hi"}])
chat("GLM-5.2", [{"role": "user", "content": "hi"}])

# 多模态（仅 Qwen3-VL-235B 等视觉模型支持）
chat("Qwen3-VL-235B", [{"role": "user", "content": [
    {"type": "text", "text": "What color is this image?"},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,<BASE64>"}},
]}])
```

### 5. 端点清单

| 端点 | 用途 |
|---|---|
| `POST /api/v2/chat/completions` | 对话（OpenAI 兼容，SSE 流式；需 CLI 请求形态） |
| `GET /v1/agent-center/agents/useragents` | agent 列表（需 `Agent-Type: AgentCenter`） |
| `GET /v1/agent-center/agents/detail?agent_id=` | agent 详情（含模型清单，`model_alias` = 路由 ID） |
| `POST /v1/sessions` | 会话注册（需 `Agent-Type: PromptCenter`；CLI 启动注册 + 120s 心跳；并发上限 3，按 `user-session-id` 计数） |

## 文件结构

```
src/index.ts       # 插件入口：V1 形态 default export { id, server }（config/provider/auth 三 hook）
src/signer.ts      # SDK-HMAC-SHA256 签名 + 签名 fetch（chat 请求 CLI 形态注入）
src/discover.ts    # agent-center 模型发现（model_alias → id，model_name → name）
src/i18n.ts        # 中英文案（提示模型名、/connect 两步流文案）
dist/              # tsc 构建产物（exports["./server"] 指向 dist/index.js）
test/plugin.test.js   # 20 个单测
test/live-check.js    # 真实 API 冒烟测试（需环境变量）
```

## 开发

```
npm install
npm run build      # tsc -> dist
npm run typecheck
npm test
```
