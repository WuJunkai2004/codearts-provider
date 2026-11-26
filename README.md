# opencode-codearts-provider

将华为云 CodeArts 提供的模型，通过插件，接入 opencode。

## 工作原理

- 复刻 CodeArts CLI（agentkernel）的请求签名（华为云 APIG `SDK-HMAC-SHA256`）与请求形态，直连 InferHub 网关
- 模型清单来自账号的 agent-center 动态下发，并合并 opengw 网关的 IDE 专属模型（deepseek-v4 / glm-5.3 等），带文件缓存兜底
- 多模态模型（`supports_images`）的图片直传聊天请求，不再借助外部视觉模型转文字
- 图片默认**原样发送、不做任何处理**。可选 `describeImages`（默认关闭）：超过 10MB 软水位时，把**旧轮**图片按 `sha256(图片)` 缓存转成文字描述，直到旧轮图片全部替换完（当前轮图片保持原生）；不丢图片、不用占位符、不做本地硬上限报错
- 可选 `compressImages`（默认关闭）：每次请求把**所有**内联图片（包括当前轮）重编码为 WebP（原分辨率，q80，基本可视为无损），按图片 hash 缓存、只编码一次。开启后**只走压缩、不调用识图模型**，并优先于 `describeImages`；压缩后仍超限则照常发给网关。因为每张图从第一次出现就是同一个 WebP，缓存前缀稳定。运行时没有 `Bun.Image` 时该选项不生效（若 `describeImages` 开启则回落到识图）
- 服务端下发的思考挡位（`supported_thinking_strengths`）映射为 opencode 模型挡位（variants），选中即注入顶层 `reasoning_effort`
- 内置每日自动签到（`USER_LOGIN` 每日签到领 1000 积分，benefit 模型的消耗额度），静默运行无需干预

协议细节（签名算法、网关路由规则、端点清单）、代码结构与构建测试说明见 [AGENTS.md](AGENTS.md)。

## 安装

### 方式一：opencode 插件安装

在 opencode 中，使用 ctrl+P 打开命令面板，输入 `plugin install`，然后输入：

```
opencode-codearts-provider
```

### 方式二：本地开发

先构建，再在对应的 `opencode.jsonc` 的 `plugin` 数组中添加本地包目录的 `file://` 路径：

```
npm install
npm run build        # 生成 dist/（opencode 加载的就是 dist/index.js）
```

```jsonc
// V2（opencode 2.x）：键名是 plugins，对象形式可带 options
{
  "plugins": [{ "package": "file:///.../codearts-provider/dist" }]
}

// V1（opencode 1.x）：键名是 plugin
{
  "plugin": ["file:///.../codearts-provider"]
}
```

## 凭证

推荐使用 `/connect` 命令选择 Huawei CodeArts，两步输入：第 1 步输入 AK（自定义提示页），第 2 步输入 SK（内置 API key 页）。存储格式：`auth.json` 中 `key` = SK、`metadata.ak` = AK。

或使用环境变量方式：

```
CODEARTS_CLI_AK=<你的AK>
CODEARTS_CLI_SK=<你的SK>
```

优先级链：`provider options` > `plugin options` > 环境变量 `CODEARTS_CLI_AK/SK` > `/connect` 存储的凭证。

**无凭证行为**：provider 始终注册（保证 /connect 里能看到），但模型列表只有一个占位模型 `connect-required`，名称显示"未连接 — 请使用 /connect 添加华为云 CodeArts AK/SK"，不发出任何推理请求。

## 使用

```
opencode models
opencode run -m codearts/openpangu-2.0-pro "hello"
opencode run -m codearts/GLM-5.2 "hello"
```

多模态模型（模型清单里"图片"列为 ✅ 的）直接在对话里贴图或给图片路径即可，图片原生随聊天请求发送，无需任何辅助工具。

## 模型缓存

模型发现结果会缓存到 `~/.local/share/opencode/codearts-models.json`（与 `auth.json` 同目录）：

- 发现失败时自动回退到缓存，插件照常可用
- 缓存**不按时间过期**（模型清单变化很少，且每次启动都会尝试重新发现）；删除该文件即可强制重新发现

## 思考挡位（服务端下发，随网关变化）

挡位的真实来源是独立端点 `POST /v1/model/thinking-variants`（`Agent-Type: PromptCenter`，请求体 `{model_names: [...]}`，与官方 CLI 的 `thinking-variants-service` 同一接口；agent-center 详情里的 `supported_thinking_strengths` 字段实践中恒为空，不是挡位来源）。插件把每一档映射为 opencode 的模型挡位（variant）：**选中某挡即在请求体注入顶层 `reasoning_effort`**——与官方 CLI 的变体机制同一线上格式。

当前网关下发（2026-11-25）：

| 挡位 | 模型 |
| --- | --- |
| `low` / `high` / `max` | deepseek-v4.1-flash-1017、glm-5.3-flash、deepseek-v4.1-flash、glm-5.3、kimi-k3.1-pro、kimi-k3 |
| `high` / `max` | GLM-5.2、glm-5.2-sft-harmony |
| 无挡位 | openpangu-2.1-pro、openpangu-2.0-pro、openpangu-2.0-flash、speed（智速模式） |

- 网关下发哪些挡位，模型就出现哪些挡位；端点未返回（如 openpangu 系列）则不显示——以网关为准，不做本地默认
- 挡位清单变化后，60 秒内的后台刷新会触发 provider reload
- `default_strength` 不消费（官方 CLI 同样忽略；其选单里的 "Default" 就是无挡位的基础模型）

## 每日签到（自动，非工具）

逆向 VSCode 插件的 welfare（权益）系统所得：每日签到（`USER_LOGIN` campaign）领取 1000 通用积分，供 deepseek-v4 / glm-5.3 等 benefit 模型消耗。**签到是静默基建，刻意不注册为 LLM 工具**——领取是确定性账号操作，不应由模型概率性触发；自动签到已覆盖日常场景。

- **自动签到**：插件启动及每 60 秒的后台刷新时尝试一次；**是否已签以服务端 `delivery` 状态为准**（本地不存状态文件，多实例/多机器共用账号不会互相误判），内存日界保证每账号每天只探测一次，失败自动退避 10 分钟再试
- **领取流程与 IDE 一致**：claim 成功后自动 confirm，积分到账（`ELIGIBLE → CLAIMED → CONFIRMED`）
- 一次性活动（学生认证 / 邀请奖励）在插件内没有领取路径，需要时用 `node test/live-check.js` 直查

```jsonc
// 完全关闭自动签到
"plugin": [["file:///path/to/codearts-provider", { "autoCheckin": false }]]
```

## 模型清单（2026-11 实测）

| 模型 ID（= model_alias） | 显示名（model_name） | 来源              | 文本 | 图片 | 思考挡位 |
| ------------------------ | -------------------- | ----------------- | ---- | ---- | -------- |
| `deepseek-v4.1-flash-1017` | DeepSeek-V4.1-Flash-1017 | agent-center 下发 | ✅ | ✅ | low/high/max |
| `glm-5.3-flash`          | GLM-5.3-Flash        | agent-center 下发 | ✅   | ✅   | low/high/max |
| `deepseek-v4.1-flash`    | DeepSeek-V4.1-Flash  | agent-center 下发 | ✅   | ✅   | low/high/max |
| `glm-5.3`                | GLM-5.3              | agent-center 下发 | ✅   | ❌   | low/high/max |
| `kimi-k3.1-pro`          | Kimi-K3.1-Pro        | agent-center 下发 | ✅   | ✅   | low/high/max |
| `kimi-k3`                | Kimi-K3              | agent-center 下发 | ✅   | ✅   | low/high/max |
| `GLM-5.2`                | GLM-5.2              | agent-center 下发 | ✅   | ❌   | high/max |
| `glm-5.2-sft-harmony`    | GLM-5.2-ArkTS-SPARK  | agent-center 下发 | ✅   | ❌   | high/max |
| `openpangu-2.1-pro`      | OpenPangu-2.1-Pro    | agent-center 下发 | ✅   | ❌   | — |
| `openpangu-2.0-pro`      | OpenPangu-2.0-Pro    | agent-center 下发 | ✅   | ❌   | — |
| `openpangu-2.0-flash`    | OpenPangu-2.0-Flash  | agent-center 下发 | ✅   | ❌   | — |
| `speed`                  | 智速模式              | agent-center 下发 | ✅   | ❌   | — |

模型清单**完全来自服务端下发**（agent-center + opengw 两个网关合并，见 `AGENTS.md`）。"思考挡位"列来自 `POST /v1/model/thinking-variants` 端点（见[思考挡位](#思考挡位服务端下发随网关变化)）——网关下发变化后 60 秒内自动生效，无需改插件。

opengw 来源的模型（deepseek-v4 系列 / glm-5.3）推理时自动附加 `maas_type: benefit` 头，消耗签到所得的通用积分；积分不足或当日未签到可能影响这些模型的可用额度。

## 配置项

在 plugin 数组中用元组形式传入（可选）：

```jsonc
"plugin": [["file:///path/to/codearts-provider", { "baseURL": "https://snap-access.cn-north-4.myhuaweicloud.com", "ak": "...", "sk": "..." }]]
```

| 选项             | 默认值                                             | 说明                                       |
| ---------------- | -------------------------------------------------- | ------------------------------------------ |
| `baseURL`        | `https://snap-access.cn-north-4.myhuaweicloud.com` | 服务 base URL                              |
| `ak` / `sk`      | 环境变量 `CODEARTS_CLI_AK/SK`                      | 凭证（完整优先级链见[凭证](#凭证)）        |
| `autoCheckin`    | `true`                                             | 是否启用每日自动签到（后台静默，每天一次） |
| `describeImages` | `false`                                            | 超过 10MB 水位时把**旧轮**图片转成文字描述（按图片 hash 缓存）。默认关闭 = 图片原样发送 |
| `compressImages` | `false`                                            | 每次请求把**所有**内联图片（包括当前轮）重编码为 WebP（原分辨率，q80，基本可视为无损），按图片 hash 缓存、只编码一次。开启后**只走压缩、不调用识图模型**，并优先于 `describeImages`；压缩后仍超限则照常发给网关报错。每张图从第一次出现就是同一个 WebP，缓存前缀稳定。依赖 opencode 内置的 `Bun.Image`，不可用时该选项不生效 |

```jsonc
// 旧轮图片转文字（默认关闭）
"plugin": [["file:///path/to/codearts-provider", { "describeImages": true }]]

// 图片压缩（默认关闭；优先于 describeImages）
"plugin": [["file:///path/to/codearts-provider", { "compressImages": true }]]

// V2 写法
"plugins": [{ "package": "file:///path/to/codearts-provider/dist", "options": { "compressImages": true } }]
```

界面语言按 `CODEARTS_LANG` > `LC_ALL` > `LANG` 检测中文/英文（提示文案双语）。

## 故障排查

**报错 `OpenAI Chat stream ended without finish_reason`**：这个报错自 v1.2.1 起已被插件根除——网关把错误包装成一行伪 SSE（`data:{"text":"[DONE]","error_code":...}`）后直接关流，AI SDK 解析不到任何合法分片才会报这个误导性错误。插件的响应守卫（`utils/sse.ts`）现在会把这类伪 SSE 归一成**真实的非 2xx JSON 错误**（状态码取自 error_code 尾段，如 `81114.429` → 429），opencode 自己的限流退避重试和错误展示随即正常接管。已实测到的触发原因与处置：

1. **账号级限流**（最常见）：`InferHub.ModelArts.81114.429 — Too many requests…`。所有 CodeArts 模型共享每分钟 500 万 token 配额；1M 上下文模型（deepseek-v4 系列）连续多轮工具调用很容易触顶。**约 1 分钟后自动恢复**；现在会看到真实的 429，opencode 内置重试会自动退避。
2. **模型未注册**：`InferHub.002002009.404`。新模型灰度期间网关部分节点尚未注册（2026-10-30 的 kimi-k3.1-pro 即如此，注册完成后自愈），或请求体 model 用了显示名而非路由别名（`model_alias`）。现在会看到真实的 404 与清晰错误消息，等注册完成或改用别名即可。
3. **请求体含 max-token 字段**（已在插件内修复）：`InferHub.001001005.400`。插件的 `applyCliBodyShape` 已剥离这些字段——若仍遇到，说明运行的 `dist/index.js` 过旧：`npm run build` 后重启 opencode。

判断方法：直接跑 `node test/live-check.js`（带 `CODEARTS_CLI_AK/SK` 环境变量），看各模型是否正常返回。

## 开发

```
npm install
npm run build      # tsc --noEmit + esbuild -> dist/index.js（单文件）
npm test
```

单条用例运行、真机冒烟测试等详见 [AGENTS.md](AGENTS.md)。
