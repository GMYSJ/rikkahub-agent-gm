# 工具桥 / TOOL BRIDGE

> 阶段 1 产出。2026-11-19。
> 主提示词第三节「双向 Agent 工具代理层」是本项目核心。
> 协议实现细节见 `PROTOCOL_SPEC.md`；本文讲**工具系统怎么对接**。

## 一、RikkaHub 工具系统的真实结构

### 1.1 `Tool` 数据类

`ai/src/main/java/me/rerere/ai/core/Tool.kt:12-19`：

```kotlin
data class Tool(
    val name: String,
    val description: String,
    val parameters: () -> InputSchema? = { null },
    val systemPrompt: (model: Model, messages: List<UIMessage>) -> String = { _, _ -> "" },
    val needsApproval: (JsonElement) -> Boolean = { false },
    val execute: suspend (JsonElement) -> List<UIMessagePart>
)
```

四个必须记住的点：

1. **`execute` 是 `suspend`** → 天然支持远程调用，不需要额外的线程/协程桥接。
2. **`needsApproval` 是函数** `(JsonElement) -> Boolean`，**不是布尔字段** → 可以按参数动态决定是否弹审批。
3. **有 `systemPrompt` 字段**（早期文档漏记）→ 工具可以给模型追加提示，`SkillsTools.kt:46` 是唯一实现者。
4. **`InputSchema` 只有一种实现**：`InputSchema.Obj(properties: JsonObject, required: List<String>?)`（同文件 `:22-28`）。

> ⚠️ 注意同名但不同的类：`ai/ui/UIMessagePart.kt:184` 的 `Tool` 是**消息里的调用记录**，不要改错。

`InputSchema` 只有一个 `Obj` 实现，意味着它与标准 JSON Schema 的 `{type:'object', properties, required}` **几乎一一对应** —— 这是双向转换成本低的关键。

### 1.2 工具从哪里装进去

**`ChatToolFactory.createTools()` 是死代码**（全仓无调用点，只有 kdoc 自引用）。

真正生效的 5 条链路：

| 链路 | 位置 |
|---|---|
| 主聊天 | `ChatService.kt:1721-1804` |
| rerun | `ChatService.kt:1449-1485` |
| 直连 | `ChatService.kt:973-980` |
| Cron | `CronJobWorker.kt:368-375` |
| Workflow | `WorkflowEngine.kt:213` |

**扩展点选择**：

- 改 `ChatService` 两处 → 覆盖主链路 + rerun，但漏掉 cron/workflow
- **改 `LocalTools.getTools()`（`LocalTools.kt:720-723`）+ 加 `assistant.localTools` 选项** → **一次覆盖全部 5 条**

`getTools()` 的真实签名（`:720-723`）：

```kotlin
fun getTools(
    options: List<LocalToolOption>,
    invocationContext: ToolInvocationContext = ToolInvocationContext.EMPTY,
): List<Tool>
```

它的结构是「**选项开关 + 逐个 if 添加**」，每个工具由一个 `LocalToolOption`
的 `data object` 控制是否装进去。已核实 `LocalToolOption` 是 `@Serializable sealed class`，
共 **50+ 个选项**（`:132-207`），并且权限敏感项是**独立选项**：

```kotlin
@SerialName("contacts")   data object Contacts   : LocalToolOption()
@SerialName("sms_inbox")  data object SmsInbox   : LocalToolOption()
@SerialName("sms_send")   data object SmsSend    : LocalToolOption()
@SerialName("keystore")   data object Keystore   : LocalToolOption()
@SerialName("camera_photo") data object CameraPhoto : LocalToolOption()
@SerialName("nfc")        data object Nfc        : LocalToolOption()
```

**这对桥是个利好**：白名单不需要另建机制 ——
「桥暴露哪些工具」可以**直接复用 `LocalToolOption` 的开关语义**，
用户没开的工具本来就不在 `getTools()` 的返回里。

**结论：挂到 `LocalTools`。** 顺带白名单问题自动解决一半。

### 1.3 审批体系（5 个组件，各有分工）

| 组件 | 位置 | 职责 |
|---|---|---|
| `ToolApprovalDefaults` | `:29-253`(ALWAYS_ASK) / `:262-293`(NO_ALWAYS_ALLOW) / **`:304-305`** | 静态分类 + `requiresApproval()` |
| `ToolApprovalAllowList` | `:16-57` | 进程内、按会话的临时放行 |
| `ToolApprovalPreferences` | `:51-116` | DataStore 持久化（alwaysAllow / globalYolo） |
| `ToolInvocationContext` | `:31-41` | **不是审批开关**，只标记「谁在调」（子代理递归守卫等） |
| `HardlineCommandGuard` | `:127/147/159`，MCP 分支 `:185` | 审批前的硬底线，Always Allow / YOLO 都**不能**覆盖 |

决策发生点：`GenerationLoop.kt:761-796`（hardline → `needsApproval` → Pending）、
`:874-891`（resume 时二次 hardline）、`:893-955`（LoopGuard）。

## 二、`mcp__` 前缀：命名即安全机制

这不是命名风格，是**整个远端工具安全模型的地基**。

`ToolApprovalDefaults.kt:304-305`：

```kotlin
fun requiresApproval(toolName: String): Boolean =
    toolName in ALWAYS_ASK || toolName.startsWith("mcp__")
```

源码注释原文（同文件 `:297-303`）说明了设计意图：

> MCP-relayed tools (`mcp__*`) are always gated because the MCP server's tool
> surface is opaque to us — we can't know which calls are destructive.

**这个理由对远端节点同样成立，而且更强**：远端节点的工具面比 MCP server 更不可知。

所以：

```kotlin
// 远端工具一律这样命名
name = "mcp__${node.slug}__${wireTool.name}"
```

好处：
- **自动继承**「默认必须人工批准」，不需要改 `ToolApprovalDefaults`
- 自动被 `HardlineCommandGuard` 的 MCP 分支（`:185`）纳入
- 命名即语义：UI 上一眼能看出这是远端工具

**反例**：若自定义 `remote__` 前缀，就必须同时改 `ToolApprovalDefaults.kt:305`
和 `HardlineCommandGuard.kt:185`，**漏改一处就是安全漏洞**。

## 三、出方向：手机调电脑

### 3.1 流程

```
手机 Agent 决定调用 mcp__windows-dsh__shell_exec
        ↓
RemoteToolFactory 包装的 Tool.execute(args)
        ↓
RemoteNodeClient.callTool("shell_exec", args)
        ↓
POST https://<电脑>:<port>/dsh-mobile-bridge/tools/call
        ↓
电脑桥 ctx.tools.execute({calls:[...], signal})
        ↓
DSH 完整流水线：pre-execute → guards → execute → post-execute
        ↓
返回 {content, value} 或 {error}
        ↓
手机转成 List<UIMessagePart>
```

### 3.2 参数与结果的转换

**参数**（`JsonElement` → 桥的 `arguments`）：

手机的 `Tool.execute` 收到的是 `JsonElement`，直接透传即可 —— JSON 本来就是桥的载荷格式。

**结果**（桥的 `content` → `List<UIMessagePart>`）：

桥返回的是 DSH 的 `ContentBlock[]`。转换表：

| DSH ContentBlock | RikkaHub UIMessagePart |
|---|---|
| `{type:'text', text}` | `Text(text)` |
| 其他类型 | `Text(JSON.stringify(block))` 兜底 |

**兜底重要**：不要因为遇到不认识的块类型就整个调用失败。
一个工具执行成功了却因为结果渲染不了而报错，是很糟的体验。

### 3.3 审批怎么接

照抄现有 MCP 工具的做法（`ChatService.kt:1793-1797`）：

```kotlin
needsApproval = { args ->
    ToolApprovalDefaults.requiresApproval(name) || node.policy(args)
}
```

因为名字带 `mcp__` 前缀，`requiresApproval(name)` 必然为 `true` ——
`node.policy(args)` 是**额外收紧**（例如只读工具可免审批），不是放宽。

## 四、入方向：电脑调手机

### 4.1 流程

```
电脑 DSH 模型调用 mcp__phone__get_battery
        ↓
桥注册的 Tool.execute(args, exec)
        ↓
callRemoteTool({ baseUrl: 手机的桥地址, tool: "get_battery", args })
        ↓
POST https://<手机>:<port>/bridge/tools/call
        ↓
手机 BridgeRoutes → LocalTools.getTools() 找到工具
        ↓
手机本地执行（Shizuku / WorkspaceFileSystem / 设备工具）
        ↓
结果回传电脑
```

**已在 `win-bridge` 实现并测试**（e2e 有专门用例验证「注册的工具真的能被 DSH 执行，并回调到手机」）。

### 4.2 手机侧必须守住的边界

| 边界 | 原因 |
|---|---|
| **必须走 `LocalTools`**，不要绕过 | 一次覆盖 5 条链路，且自动带上审批 |
| **不能绕过 `ToolApprovalDefaults`** | 远程调用不得比本地调用更容易 |
| **工具白名单**，不暴露全部 90+ | 短信/通讯录/相机/keystore 默认不暴露 |
| **路径必须来自 `WorkspaceManager.filesDir()`** | 不能吃网络传来的绝对路径，否则绕过 `resolvePath` 逃逸校验 |
| **Shizuku 保留授权流程** | 不能因为远程就跳过 AIDL 授权 |

### 4.3 一个已知风险

`LocalTools.getTools()` 里有 IO 操作（如 `BrowserPreferences.kt:116-127`）。
在桥的 HTTP handler 里直接调用会阻塞 Ktor 的事件循环。

**必须**包在 `Dispatchers.IO` 里。

## 五、防循环、防重、防丢

| 风险 | 措施 | 状态 |
|---|---|---|
| A→B→A 循环 | 跳数 +1，≥2 拒绝，且**不执行任何工具** | ✅ 已实现并测试 |
| 自我回显 | `mcp__` 前缀工具不通过 `/tools` 暴露、不允许经 `/tools/call` 调用 | ✅ 已实现并测试 |
| 同一请求重复执行 | 无（v1 只透传 `request_id`，未做服务端去重） | ❌ 未实现 |
| 工具结果丢失 | 失败抛异常而非静默返回 | ✅ 已实现 |
| 节点离线仍被调用 | 入方向执行前查 `remoteNodes`，查不到就抛错 | ✅ 已实现 |
| 工具名冲突 | 前缀含 nodeSlug；同名重注册先撤旧的 | ✅ 已实现并测试 |

**未实现项说明**：`request_id` 去重需要服务端状态表 + TTL，属阶段 4。
在此之前，调用方应保证不重放。这是已知缺口，不是遗漏。

## 六、工具的元数据声明

主提示词要求每个工具标明 11 项。映射到现有结构：

| 要求 | 落在哪 |
|---|---|
| 工具名称 | `Tool.name`（含 `mcp__<node>__` 前缀） |
| 工具描述 | `Tool.description` |
| 所属节点 | 从名字前缀解析，或 `RemoteNodeRegistry` 查 |
| 参数结构 | `Tool.parameters()` → `InputSchema.Obj` |
| 返回结构 | **无对应字段** → 落在 `description` 文本里 |
| 所需权限 | `needsApproval` + 节点白名单 |
| 风险等级 | `ToolApprovalDefaults` 分类 + 节点策略 |
| 异步执行 | `execute` 是 suspend，天然支持 |
| 取消 | 桥的 `signal` → `AbortController` → 对上传播 |
| 进度报告 | **无对应字段** → 未实现 |
| 远程可调用 | 桥的 `/tools` 清单即白名单 |

**两个结构性缺口**（诚实记录）：`返回结构` 与 `进度报告` 在 RikkaHub 的 `Tool`
里没有对应字段，只能塞进描述文本，或等后续给 `Tool` 加字段（那是侵入性改动）。

## 七、落地状态

| 部分 | 状态 |
|---|---|
| DSH 侧桥（`/tools`、`/tools/call`、`/register`、`/mcp`） | ✅ 已实现，126 用例通过 |
| 协议与 schema 双向转换 | ✅ 已实现并有真实宿主校验 |
| 手机侧桥端点（Ktor 路由） | ❌ 未开始 |
| `RemoteToolFactory` / `RemoteNodeClient`（Kotlin） | ❌ 未开始 |
| `LocalTools` 挂载点改造 | ❌ 未开始 |
| 手机侧设置页 | ❌ 未开始 |

**下一步最短路径**：先在 `web` 模块加桥路由（复用现成的 `startWebServer`），
再写 `RemoteNodeClient`，最后挂进 `LocalTools`。

## 八、待验证的假设

- [ ] `UIMessagePart` 与 DSH `ContentBlock` 的完整类型对照（图片/文件块）
- [ ] 手机侧工具执行是否也能拿到 `AbortSignal`（Kotlin 侧对应 `CancellationException`）
- [ ] `LocalToolOption` 的 `data object` 能否从桥的 wire 名字反解（需要一张映射表）

### 已核实、不再是假设的项

- [x] `LocalTools.getTools(options, invocationContext)` 签名与「选项开关 + if 添加」结构
- [x] `LocalToolOption` 是 sealed class，50+ 选项，权限敏感项独立开关
- [x] `ToolApprovalDefaults.requiresApproval()` 对 `mcp__` 前缀恒为 true（含源码注释原意）
- [x] `WebApiModule` 的 `routing { route("/api") { ... } }` **只占 `/api` 前缀**
      → 桥用独立路径（如 `/bridge`）**不会冲突**
- [x] `WebApiModule` 已有 `authenticate("auth-jwt")` 分支（`:170-186`），
      桥端点可以直接嵌进同一套 JWT 鉴权，不需要另建
- [x] `web/Entry.kt` 的 `startWebServer(port, host, module)` 是 `suspend Application.() -> Unit`，
      桥路由可作为 `module` 的一部分挂上去
