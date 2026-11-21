# 模型路由 / MODEL ROUTING

> 阶段 1 产出。2026-11-19。
> 主提示词第四节「统一模型系统」是本项目**最高优先级功能**，不允许降级为两个模型列表简单合并。

## 〇、先纠正一个错误结论

我在上一轮总结里说过：「电脑是 OpenAI 兼容端点，手机侧加个 `ProviderSetting.OpenAI(baseUrl=...)` 即可，**零代码**」。

**这个说法是错的**，实测复核如下：

| 核查项 | 结论 |
|---|---|
| DSH 是否对外提供 `POST /v1/chat/completions` | ❌ **不提供** |
| DSH 里出现的 `/v1/models` 是什么 | 是 `dsh-llm-pi-ai/src/discovery.ts` 里**出站**去问上游厂商的客户端代码，不是本地端点 |
| DSH 的本地 HTTP 服务面 | 只有 webServer 的 UI 静态资源、`/api`（Typert RPC）、`/api/remote.mux`（WS） |

所以「加个 baseUrl 就能用电脑模型」**不成立** —— 电脑侧根本没有那个 URL 可以指。

正确路径见第四节。

## 一、两端的真实模型体系

### 1.1 手机侧（RikkaHub）

```
ProviderManager            注册 4 个内置 Provider
  ├─ "openai"    → OpenAIProvider
  ├─ "google"    → GoogleProvider
  ├─ "claude"    → ClaudeProvider
  └─ "aicore"    → AICoreProvider（端侧）

getProviderByType(setting)  穷尽 when 分派（ProviderManager.kt:51-64）
  覆盖 9 种 ProviderSetting 子类：
  OpenAI / Google / Claude / AICore / LiteRtLocal / LlamaCppLocal /
  Codex / Grok / GeminiOAuth
```

`ProviderSetting` 是 **sealed class**（`ProviderSetting.kt:26`），子类各自带
`apiKey` / `baseUrl` / `customHeaders` 等字段。例如 `OpenAI`（`:56-78`）：

```kotlin
var apiKey: String = ""
var baseUrl: String = "https://api.openai.com/v1"
var chatCompletionsPath: String = "/chat/completions"
var useResponseApi: Boolean = false
var promptCaching: Boolean = true
var routing: OpenRouterRouting = OpenRouterRouting()
```

`Model`（`Model.kt:8-25`）带一个关键字段：

```kotlin
val providerOverwrite: ProviderSetting? = null
```

**这意味着单个模型可以覆盖其所属 Provider 的连接参数** —— 统一模型注册表可以
把一个「远端模型」挂在现有 Provider 下，而不必新增 Provider 类型。见 4.2。

模型能力声明（`Model.kt`）：

```kotlin
val inputModalities:  List<Modality>      = listOf(TEXT)   // TEXT | IMAGE
val outputModalities: List<Modality>      = listOf(TEXT)
val abilities:        List<ModelAbility>  = emptyList()    // TOOL | REASONING
val tools:            Set<BuiltInTools>   = emptySet()     // Search | UrlContext | ImageGeneration
val contextLength:    Int?                = null
val supportedParameters: List<String>     = emptyList()
```

### 1.2 电脑侧（DSH）

```
ctx.llm  (LlmRuntime)
  ├─ listProviders()                       按注册顺序报告已注册路由
  ├─ stream(GenerateOptions)               流式调用任意已注册提供方
  └─ prepareCall(config, signal, configure?)  校验并冻结调用配置
```

`GenerateOptions`（`dsh-llm/src/types.ts:564-606`）是真正的接入点：

```ts
interface GenerateOptions {
  provider: string            // 已注册的路由名，如 'workbuddy' / 'deepseek'
  model: string
  reasoningEffort?: ReasoningEffortId
  messages: RequestMessage[]
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: Branded<'SessionId'>
  purpose?: Purpose
}
```

流以 `block-start` → `text-delta`… → `usage` → `finish` 分片返回，
**始终以终止 `finish` 分片结束**。

DSH 侧实际已注册的 provider 路由（来自 profile 的 `llm-pi-ai` 行）：
`deepseek`、`github`、`shusheng`、`token-harbor`、`agnes`、`qiniu`、`hutao`、
`cherry-studio-*`，以及 `workbuddy`（`dsh-connect-workbuddy` 提供）。

## 二、统一模型注册表的数据模型

两端字段要对齐到同一套词汇。建议模型：

```kotlin
data class UnifiedModel(
    val uid: String,              // 全局唯一，见 3 节命名规则
    val displayName: String,
    val nodeId: String,           // "phone" | "windows-dsh"
    val providerRoute: String,    // 节点内的 provider 标识
    val modelId: String,          // 节点内的真实模型 ID
    val inputModalities: List<Modality>,
    val outputModalities: List<Modality>,
    val abilities: List<ModelAbility>,      // TOOL / REASONING
    val contextLength: Int?,
    val online: Boolean,          // 节点可用性，非模型能力
    val authOwnedByNode: String,  // 认证归属节点，密钥永不跨端复制
)
```

**能力声明的诚实原则**（主提示词明确要求）：

> 「不得让一个仅支持普通文本生成的模型被错误标记为完整 Agent 模型。」

落地规则：

| 判据 | 结论 |
|---|---|
| `abilities` 含 `TOOL` **且** 节点侧实测通过一次工具调用 | 才可标记为 Agent 可用 |
| 仅有 `TEXT` 输出、未验证工具调用 | 标为「纯对话」，UI 上不可选为 Agent 执行模型 |
| 模型来自远端且该远端离线 | `online=false`，明确显示状态，不静默降级 |

**「API 兼容 ≠ Agent 协议兼容」**：一个 OpenAI 兼容端点能返回文本，
不代表它能正确处理 `tools` 参数与流式工具调用增量。

## 三、统一命名与去重

```
uid = "<nodeId>/<providerRoute>/<modelId>"
例：  "phone/openai/gpt-4.1"
      "windows-dsh/workbuddy/deepseek-v4.1-flash"
```

**去重规则**（按优先级）：

1. `uid` 完全一致 → 同一条，合并（保留较新的能力元数据）
2. 不同 node 但 `(providerRoute, modelId)` 相同 → **不合并**，是两个可用副本
   （一个来自手机直连，一个来自电脑代理），UI 上标注来源节点
3. 同 node 内 `modelId` 相同但 `providerRoute` 不同 → 不合并（用户可能故意配了两个 key）

**冲突处理**：`Model.providerOverwrite` 允许单模型覆盖 Provider 参数，
所以「同名模型不同端点」在手机侧本来就已支持，不需要新机制。

## 四、两个方向的落地方案

### 方向 A：手机模型 → 电脑使用

**现状**：手机 RikkaHub 已有一堆 Provider 配置（含 API Key）。

**方案**：手机侧的桥端点新增 `POST /llm/stream`，让电脑经桥调用手机的模型。

```
电脑 DSH                         手机 RikkaHub
  ctx.llm.stream(...)              BridgeRoutes
        │                                ▲
        └── HTTPS ──→ POST /llm/stream ──┘
                        │
                        └─ ProviderManager.getProviderByType(setting)
                              .streamText(setting, messages, params)
```

**关键：密钥不跨端**。电脑发请求，手机用自己存的 key 调上游，key 永远不出手机。
这满足主提示词「避免不必要地复制 API Key」与「不得将密钥暴露给不需要它的另一端」。

**必须解决的兼容问题**（主提示词第 4.4 节逐条列出）：

| 项 | 手机侧要做的 |
|---|---|
| 流式 | 把 `Flow<StreamChunk>` 翻成桥的帧格式（SSE 或分块 JSON） |
| 工具调用 | `TextGenerationParams.tools` 要能穿过桥；`Tool` 是 suspend，能序列化参数即可 |
| 多轮工具 | 保持 `UIMessage` 历史语义完整 |
| 图片输入 | 按 `inputModalities` 校验，不支持就明确报错而不是静默丢弃 |
| 思考内容 | `REASONING` 能力要如实上报 |
| 取消 | 桥的 `signal` 要贯通到 `streamText` 的协程 |
| 超时 | 单次请求超时 + 整体超时 |

### 方向 B：电脑模型 → 手机使用

**方案 A（推荐）：桥作为 OpenAI 兼容门面**

在桥里加一层 `POST /llm/v1/chat/completions`，内部转发到 `ctx.llm.stream()`。
手机侧就能直接用现成的 `ProviderSetting.OpenAI(baseUrl = "https://<电脑>/bridge/llm/v1")`。

优点：
- 手机侧**零改动**（用现成的 OpenAI Provider）
- DSH 侧只需实现一层 SSE 转换
- 工具调用按 OpenAI 的 `tools` / `tool_calls` 格式映射到 `GenerateOptions.tools`

缺点：
- 需要做两套工具 schema 的互转（OpenAI 格式 ↔ DSH `ToolSchema`）
- 流式分片要按 SSE 的 `data: {...}\n\n` 编码，并正确处理 `[DONE]`

**方案 B（备选）：桥定义自己的 `/llm/stream`**

两端都自己实现。好处是能原样传 `GenerateOptions` 语义（含 `reasoningEffort`、
`purpose`）；坏处是手机侧要新写一个 `Provider` 子类 —— 而那是 **10 处改动**，
其中 3 处是**会编译失败的穷尽 `when`**：

| 文件 | 位置 |
|---|---|
| `PreferencesStore.kt` | `:627-663` |
| `ChatboxImporter.kt` | `:671-688` |
| `CherryStudioProviderImporter.kt` | `:126-134` |

外加 `ProviderConfigure.kt` 的 **7 个** `when`（`:112-140`、`:147-157`、`:158-167`、
`:217-225`、`:229-237`、`:244-252`、`:258-266`）。

**结论：选方案 A。** 用现成的 OpenAI Provider，代价最小。

### 方向 C（补充）：`providerOverwrite` 挂载法

如果不想让手机把电脑当「另一个 OpenAI」，而是想让它出现在原 Provider 列表里，
可以用 `Model.providerOverwrite` 把一个模型指向桥的端点：

```kotlin
val remoteModel = Model(
    modelId = "deepseek-v4.1-flash",
    displayName = "[电脑] DeepSeek V4.1 Flash",
    providerOverwrite = ProviderSetting.OpenAI(
        baseUrl = "https://192.168.1.3:8443/bridge/llm/v1",
        apiKey = "<桥的 token>"
    ),
    abilities = listOf(ModelAbility.TOOL, ModelAbility.REASONING),
)
```

**这条路同样零代码。** 已核实其生效路径：

```kotlin
// PreferencesStore.kt:1115-1122
fun Model.findProvider(providers: List<ProviderSetting>, checkOverwrite: Boolean = true): ProviderSetting? {
    val provider = findModelProviderFromList(providers) ?: return null
    val providerOverwrite = this.providerOverwrite
    if (checkOverwrite && providerOverwrite != null) {
        return providerOverwrite.copyProvider(models = emptyList())
    }
    return provider
}
```

`findProvider` 在**所有真实调用点**都被使用，且默认 `checkOverwrite = true`：

| 调用点 | 用途 |
|---|---|
| `GenerationLoop.kt:506` | **主生成链路**（模型执行） |
| `ChatService.kt:1513 / 2151 / 2198 / 2620` | 会话标题、摘要、重跑等 |
| `TranslationHandler.kt:34` | 翻译 |
| `OcrTransformer.kt:128` | OCR |
| `ImgGenVM.kt:196 / 240` | 图片生成 |
| `SearchPicker.kt:183` / `FilesPicker.kt:113` | 选模型时的能力判断 |

**一个必须注意的例外**：`ModelList.kt:335` 显式传了 `checkOverwrite = false`。
这是**故意的** —— 模型选择列表要按「模型归属于哪个 Provider」分组显示，
用覆盖后的 Provider 会导致分组错乱。所以：

> `providerOverwrite` 只影响**执行**，不影响**列表归属**。
> 这意味着 UI 上它仍显示在原 Provider 名下 —— 想让它分区显示，需要另外处理。

## 五、认证隔离

| 场景 | 谁持有密钥 | 密钥是否过桥 |
|---|---|---|
| 手机模型 → 电脑用 | 手机 | ❌ 不过桥（电脑只发消息，手机自己拿 key 调上游） |
| 电脑模型 → 手机用 | 电脑 | ❌ 不过桥（手机只拿桥的 token） |

**桥的 token ≠ 上游厂商的 key**。桥 token 只用于「手机证明自己是这台手机」，
一旦泄露，攻击者能用你的电脑模型额度，但**拿不到任何厂商 key**。

需要额外做：
- 桥 token 与设备配对绑定（复用现有 `devices.json` 的配对身份）
- 桥日志里不得出现 key（`leak_guard` 可做发布前兜底检查）

## 六、模型下线与降级

| 情形 | 行为 |
|---|---|
| 远端节点离线 | 该节点全部模型 `online=false`，UI 灰显，**保留配置**不清空 |
| 模型在上游 404 | 标记该模型不可用，保留配置，提示用户 |
| 流式过程中断 | 按 `maxStreamRetries` 重试；桥侧要能续传或明确失败 |
| 上下文超限 | 按 `contextLength` 提前拒绝，而不是等上游报错 |

**不得**为了「看起来能用」而静默把请求降级到另一个模型 —— 用户选了哪个就是哪个。

## 七、落地顺序

| 步骤 | 内容 | 依赖 |
|---|---|---|
| 1 | 桥加 `/llm/v1/chat/completions`（SSE + 工具 schema 互转） | 现有桥框架 |
| 2 | 手机侧配 `ProviderSetting.OpenAI(baseUrl=桥)` 或 `providerOverwrite` | 步骤 1 |
| 3 | 实测：普通聊天 → 流式 → 单轮工具 → 多轮工具 → 图片 | 步骤 2 |
| 4 | 桥加 `/llm/stream`，实现方向 A（手机模型给电脑） | 手机侧桥端点 |
| 5 | 统一模型列表 UI（合并两端 + 状态徽标） | 3、4 |

**当前状态：0/5。** 本文件是设计，尚无实现。

## 八、待验证的假设（诚实清单）

以下**没有实测过**，实现时必须逐条验证：

- [ ] `ctx.llm.stream()` 产出的分片能否无损映射成 OpenAI SSE 格式
      （已知分片序列是 `block-start` → `text-delta`… → `usage` → `finish`，
      但要确认工具调用增量、思考内容是否都能表达）
- [ ] DSH 的 `ToolSchema` 与 OpenAI `tools` 字段的双向转换是否有信息损失
      （`dsh-tools` 的 schema DSL 支持 `oneOf`/`json`，OpenAI 侧未必等价）
- [ ] 手机 `OpenAIProvider` 遇到非标准 SSE 时行为如何（是否会直接报错）
- [ ] 电脑侧 `workbuddy` 这类走**插件认证**的 provider，经桥转发时能否正常工作
      （它的 key 由 `dsh-connect-workbuddy` 管理，不是普通 apiKeyEnv）
- [ ] 双向工具调用在跨模型代理时是否会与 `mcp__` 前缀规则冲突
      （远端模型若也返回工具调用，前缀怎么加需要单独设计）

### 已核实、不再是假设的项

- [x] `providerOverwrite` 被 `GenerationLoop.kt:506` 等 11 处使用，默认生效
- [x] 例外：`ModelList.kt:335` 用 `checkOverwrite = false`（列表分组用）
- [x] `ProviderManager.getProviderByType()` 对 9 种 `ProviderSetting` 穷尽分派
- [x] `Provider.streamText()` 返回 `Flow<StreamChunk>`（不是 `stream`）
- [x] `ctx.llm.stream(GenerateOptions)` 与 `listProviders()` 真实存在
- [x] DSH **不**对外提供 OpenAI 兼容端点（`/v1/models` 是出站发现代码）
