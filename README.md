# opencode-codearts-provider

将华为云 CodeArts 提供的模型，通过插件，接入 opencode。

## 工作原理

- 复刻 CodeArts CLI（agentkernel）的请求签名（华为云 APIG `SDK-HMAC-SHA256`）与请求形态，直连 InferHub 网关
- 模型清单来自账号的 agent-center 动态下发，带文件缓存兜底
- 内置 `codearts_vision` 工具：主模型没有视觉能力时，用固定的视觉模型把图片转成文字

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

主模型无法看图时，直接在对话里给出图片路径，模型会自行调用 `codearts_vision`：

```
这张截图报什么错？test/fixtures/error.png
```

## 模型缓存

模型发现结果会缓存到 `~/.local/share/opencode/codearts-models.json`（与 `auth.json` 同目录）：

- 发现失败时自动回退到缓存，插件照常可用
- 缓存**不按时间过期**（模型清单变化很少，且每次启动都会尝试重新发现）；删除该文件即可强制重新发现

## 视觉工具（`codearts_vision`）

插件注册一个 LLM 工具 `codearts_vision`：内部把图片交给固定的视觉模型（默认 `Qwen3-VL-235B`，路由别名）转成文字，再把文字交给主模型。

- **参数**：`image`（本地路径，相对路径按会话项目目录解析）/ `image_url`（远程 URL 或 `data:` URL）；`prompt` 可选，缺省为"详细描述这张图片"
- 无凭据时调用会返回明确错误（提示 `/connect`），而不是静默失败

```jsonc
// 关闭工具 / 换模型
"plugin": [["file:///D:/code/huaweicode/codearts-provider", { "visionTool": false }]]
"plugin": [["file:///D:/code/huaweicode/codearts-provider", { "visionModel": "Qwen3-VL-235B" }]]
```

> 用 `/connect` 添加凭据后需**重启 opencode**，工具才会随进程重新注册（同 `opencode.json` 改动）。

### 局限：贴图无法交给工具

**直接在对话框粘贴/拖拽图片不支持。** 这类图片主模型读不了，工具调用也拿不到字节。目前可行的用法是**提供图片路径或 URL**：

```
这张截图报什么错？C:\Users\me\Pictures\error.png
```

## 模型清单（2026-09 实测）

| 模型 ID（= model_alias） | 显示名（model_name） | 来源              | 文本 | 图片 |
| ------------------------ | -------------------- | ----------------- | ---- | ---- |
| `openpangu-2.0-pro`      | OpenPangu-2.0-Pro    | agent-center 下发 | ✅   | ❌   |
| `openpangu-2.0-flash`    | OpenPangu-2.0-Flash  | agent-center 下发 | ✅   | ❌   |
| `GLM-5.2`                | GLM-5.2              | agent-center 下发 | ✅   | ❌   |
| `glm-5.2-sft-harmony`    | GLM-5.2-ArkTS-SPARK  | agent-center 下发 | ✅   | ❌   |
| `Qwen3-VL-235B`          | Qwen3-VL-235B        | agent-center 下发 | ✅   | ✅   |

模型清单**完全来自 agent-center 下发**。

以下模型网关可路由但**该账号未注册**（`InferHub.002002009 not registered`），因此不在下发清单中：`Qwen3.6-27B-VL`、`Qwen3.5-397B-A17B-VL`、`Qwen3-Coder-30B-A3B-Instruct`、`ClaudeV1`。

## 配置项

在 plugin 数组中用元组形式传入（可选）：

```jsonc
"plugin": [["file:///D:/code/huaweicode/codearts-provider", { "baseURL": "https://snap-access.cn-north-4.myhuaweicloud.com", "ak": "...", "sk": "..." }]]
```

| 选项          | 默认值                                             | 说明                                |
| ------------- | -------------------------------------------------- | ----------------------------------- |
| `baseURL`     | `https://snap-access.cn-north-4.myhuaweicloud.com` | 服务 base URL                       |
| `ak` / `sk`   | 环境变量 `CODEARTS_CLI_AK/SK`                      | 凭证（完整优先级链见[凭证](#凭证)） |
| `visionTool`  | `true`                                             | 是否注册 `codearts_vision` 工具     |
| `visionModel` | `Qwen3-VL-235B`                                    | 视觉工具使用的模型路由别名          |

界面语言按 `CODEARTS_LANG` > `LC_ALL` > `LANG` 检测中文/英文（提示文案双语）。

## 开发

```
npm install
npm run build      # tsc --noEmit + esbuild -> dist/index.js（单文件）
npm test
```

单条用例运行、真机冒烟测试等详见 [AGENTS.md](AGENTS.md)。
