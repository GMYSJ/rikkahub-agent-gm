# 架构设计 / ARCHITECTURE

> 阶段 1 产出。基于阶段 0 源码审计 + 2026-11-19 的**实测修正**。
>
> ⚠️ **本文已按实测结论修订。** 上一版有两处硬错误（DSH 当作 MCP Server、
> `ChatToolFactory` 当作注入点），均已在 2026-11-19 证伪。修订依据见 `PROTOCOL_SPEC.md`。
> 协议细节以 `PROTOCOL_SPEC.md` 为准，本文只讲结构。

## 一、总体架构

```
┌─────────────────────── Android (RikkaHub) ───────────────────────┐
│                                                                   │
│  Compose UI（唯一交互主体）                                        │
│    ├─ 聊天页（原有）                                              │
│    ├─ 设备管理页【新增】                                          │
│    ├─ 连接配置页【新增】                                          │
│    └─ 执行节点选择器【新增】                                       │
│                                                                   │
│  Agent 引擎（原有，不改内核）                                      │
│    ├─ LocalTools.getTools()  ← 真正的工具聚合点（一次覆盖 5 条链路）│
│    │    ├─ 设备工具 / Shizuku / Workspace（原有）                  │
│    │    ├─ McpManager → 外部 MCP Server（原有客户端能力，保留）     │
│    │    └─ 【新增】RemoteNodeTools：把电脑工具包装成 Tool          │
│    └─ ProviderManager  ← 模型聚合点                                │
│         └─ 【新增】远端 Provider（最省事：复用 OpenAI 兼容类型）    │
│                                                                   │
│  【新增】BridgeHost（复用 web 模块的 Ktor CIO，已现成）            │
│    ├─ 出：把手机工具列给电脑                                       │
│    └─ 入：执行电脑回调过来的工具调用（走 LocalTools，不绕审批）      │
│                                                                   │
│  【新增】RemoteNodeRegistry                                        │
│    └─ 电脑节点：地址、token、在线状态、工具清单                     │
└───────────────────────┬───────────────────────────────────────────┘
                        │  自制极简 HTTP 协议 v1（已实现并测试）
                        │  局域网 HTTPS / cpolar / Tailscale 只是 baseUrl 不同
┌───────────────────────▼───────────────────────────────────────────┐
│                       Windows DSH                                 │
│                                                                   │
│  DSH 宿主（不改核心，不碰 app.asar）                               │
│    ├─ 【已实现】win-bridge 插件（dsh-mobile-bridge）               │
│    │    ├─ 出：GET /tools + POST /tools/call（暴露 DSH 工具）      │
│    │    ├─ 出：POST /mcp（MCP 兼容，手机零代码接入）               │
│    │    ├─ 入：POST /register（接收手机工具，注册进 ctx.tools）     │
│    │    └─ 挂在 ctx.webServer → 自动继承 DSH 端口                 │
│    └─ ctx.tools 注册表（原有；桥执行走 ctx.tools.execute）         │
└───────────────────────────────────────────────────────────────────┘
```

## 二、关键设计决策

### 2.1 通信协议：自制极简 HTTP，**不用 MCP**

**这是相对上一版的重大修正。**

上一版的理由是「仓库已有 MCP SDK，不重复造轮子」。但那条推理漏了一步：
**MCP SDK 只有客户端**。实测证据：

- `@deepseek-ai/dsh-mcp-client` 只 import `@modelcontextprotocol/client`
- `node_modules/@modelcontextprotocol/` 下只有 `client` 与 `core`，**`server` 未打包**
- 全仓无 `createMcpServer` / `serveMcp` 任何实现

所以「DSH 当 MCP Server」不是「难做」，是**不存在**。

**新协议的三条硬理由**：

1. **它挂在 `ctx.webServer` 上** → 自动继承 DSH 端口，不需要端口发现，
   直接规避了「DSH 每次重启换端口 + 无 portfile」这个死结。
2. **协议小到可以完整测试** → 126 个用例，覆盖到真 HTTP 服务器与真实 `defineTool`。
3. **两个方向共用一套端点** → 两端装同一个插件就能互调，实现必然对称，不会漂移。

**代价**（诚实记录）：要自己维护协议；v1 能力窄（只有工具面）。

### 2.2 工具代理：包装为 `Tool` 数据类

RikkaHub 的 `Tool` 真实定义（`ai/.../core/Tool.kt:12-19`，**上一版漏记了 `systemPrompt`**）：

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

注意 `needsApproval` 是**函数** `(JsonElement) -> Boolean`，不是布尔字段。

**远端工具包装**：

```kotlin
fun remoteTool(node: RemoteNode, wireTool: WireTool): Tool = Tool(
    name = "mcp__${node.slug}__${wireTool.name}",   // 前缀是安全机制，见 2.4
    description = "[${node.label}] ${wireTool.description}",
    parameters = { wireTool.parameters.toInputSchema() },
    needsApproval = { args -> ToolApprovalDefaults.requiresApproval(name) || node.policy(args) },
    execute = { args -> node.client.callTool(wireTool.name, args) }
)
```

**真正的注入点不是 `ChatToolFactory`**（那是死代码，全仓无调用点）。
实际生效的 5 条链路：

| 链路 | 位置 |
|---|---|
| 主聊天 | `ChatService.kt:1721-1804` |
| rerun | `ChatService.kt:1449-1485` |
| 直连 / cron / workflow | `ChatService.kt:973-980` / `CronJobWorker.kt:368-375` / `WorkflowEngine.kt:213` |

**最干净的做法**：挂进 `LocalTools.getTools()`（`LocalTools.kt:720-723`），配一个
`assistant.localTools` 新选项 —— **一次改动自动覆盖全部 5 条链路**。

### 2.3 模型代理：最省事是零代码

电脑侧模型最终是 OpenAI 兼容端点。手机侧 RikkaHub 已有
`ProviderSetting.OpenAI(baseUrl = ...)`，**直接加一条配置即可，不需要写代码**。

只有需要独立节点标识/独立鉴权时才值得新建 `Provider` 子类 —— 代价是 10 处改动，
其中 3 处是**会编译失败的穷尽 `when`**（`PreferencesStore.kt`、`ChatboxImporter.kt`、
`CherryStudioProviderImporter.kt`），外加 `ProviderConfigure.kt` 的 7 个 `when`。

`Provider` 的流式方法签名（上一版写错）：

```kotlin
suspend fun streamText(
    providerSetting: T,
    messages: List<UIMessage>,
    params: TextGenerationParams
): Flow<StreamChunk>          // ← 是 streamText，不是 stream；返回 Flow<StreamChunk>
```

### 2.4 安全：桥不是审批旁路

这是整个架构里**最不能妥协的一条**。

```
桥执行工具  →  ctx.tools.execute({ calls, signal })
                  ↓
        pre-execute → guards → execute → post-execute
                  ↓
         HardlineCommandGuard 与用户审批照常生效
```

如果图省事直接调 `definition.execute()`，等于给远程调用开了一条绕过全部守卫的后门 ——
这正是主提示词明令禁止的「工具权限被远程调用绕过」。

配套的**命名约定即安全机制**：

```
远端工具名 = mcp__<nodeSlug>__<原始名>
```

因为 RikkaHub 里有一条现成规则（`ToolApprovalDefaults.kt:304-305`）：

```kotlin
requiresApproval = name in ALWAYS_ASK || name.startsWith("mcp__")
```

用这个前缀，远端工具自动继承「默认要求人工批准」，不需要改审批表，也不会漏。

### 2.5 工作区访问：显式路径 + realpath 校验

- 手机访问电脑：走桥的 `fs_*` 工具（限定在白名单根内）
- 电脑访问手机：走 `WorkspaceFileSystem`，**路径根必须来自 `WorkspaceManager.filesDir()`**

**关键**：绝不能直接使用网络传来的绝对路径。`WorkspaceFileSystem.resolvePath`
（`:234-251`）已经做了 canonical 归一 + `startsWith(rootPath + sep)` 逃逸校验，
绕过它等于把整个手机文件系统交出去。

**不采用**网络挂载（SMB/WebDAV）—— 复杂、脆弱、Android 侧支持差。

### 2.6 任务持久化：独立任务管理器

```
TaskManager
├─ 任务定义：task_id / source_node / target_node / status / result / created_at
├─ 存储：Room（app 模块已有 DB 基建）
├─ 断线后：任务在目标节点继续跑，手机重连后拉状态
└─ 取消：phone → 桥 callTool(cancel_task, {task_id})
```

**v1 未实现**，属阶段 6。

## 三、目录结构

### Android 侧（规划，尚未创建）

```
app/src/main/java/me/rerere/rikkahub/
├─ remote/                          【新增】远程节点
│  ├─ RemoteNode.kt                 节点数据模型
│  ├─ RemoteNodeRegistry.kt         节点注册表
│  ├─ RemoteNodeClient.kt           桥协议客户端（照 PROTOCOL_SPEC 实现）
│  ├─ RemoteToolFactory.kt          远端工具 → Tool
│  └─ RemoteTaskManager.kt          跨端任务（阶段 6）
├─ bridgehost/                      【新增】手机侧桥端点
│  ├─ BridgeRoutes.kt               挂到 WebApiModule 的子路由
│  └─ ToolExposurePolicy.kt         工具白名单
└─ ui/pages/setting/remote/         【新增】设置页
   └─ SettingRemoteNodePage.kt
```

### Windows 侧（✅ 已实现）

```
repos/rikkahub-agent-gm/win-bridge/
├─ package.json                     dsh.bundle.patch 指向 cordis.patch.yml
├─ cordis.patch.yml                 用 - insert: 挂载，默认 enabled: false
├─ README.md
├─ lib/
│  ├─ mcp.js                        MCP Streamable HTTP 兼容端点（手机零代码接入）
│  ├─ index.js                      插件入口：6 个端点 + 工具注册
│  ├─ protocol.js                   协议常量 / trace / 循环防护 / 工具名限定
│  ├─ schema.js                     DSH spec ↔ JSON Schema 双向转换
│  └─ client.js                     出站调用（DSH 当客户端）
└─ test/
   ├─ smoke.mjs   (43)              纯逻辑
   ├─ client.mjs  (17)              出站调用
   ├─ e2e.mjs     (25)              真 HTTP 服务器，两个桥互调
   ├─ host-load.mjs (12)            真实 DSH 运行时校验
   └─ mock-host.mjs                 最小宿主替身
```

## 四、安全模型

### 4.1 鉴权（分层）

| 层 | 机制 |
|---|---|
| 传输 | 局域网 HTTPS（复用现有自签 CA）/ 隧道 |
| 桥 | 可选 `Bearer token`，等长异或比较 |
| 工具 | 走 `ctx.tools.execute`，继承 DSH 全部守卫与审批 |
| 命名 | `mcp__` 前缀 → RikkaHub 默认人工批准 |

**不关闭证书校验**（主提示词红线）。

### 4.2 工具暴露白名单

桥默认 `enabled: false`，不开启就一个端点都不挂。开启后暴露范围仍应受限：

| 工具类 | 默认 |
|---|---|
| 只读（`fs_read` / 列目录 / 系统信息） | 可暴露 |
| 写文件、执行命令 | 需审批（由 DSH 流水线保证） |
| 短信 / 通讯录 / 相机 | **不暴露** |
| `keystore_*` | **不暴露** |

### 4.3 防循环调用

三重保护，全部有测试：

1. `hop_count >= 2` → 508 拒绝，**且不执行任何工具**
2. 不能通过桥调用桥自己注册的远端工具 → 403
3. `/tools` 不回显 `mcp__` 前缀工具，避免自我无限增长

## 五、分阶段落地

| 阶段 | 内容 | 状态 |
|---|---|---|
| 3 | DSH 侧桥 + 手机端接入 | 🔶 **DSH 侧完成（97 测试通过）**，手机侧待做 |
| 4 | 手机侧桥 + 电脑接入 | 待做 |
| 5 | 统一模型（最省事：OpenAI 兼容零代码） | 待做 |
| 6 | 跨端任务管理 | 待做 |
| 7 | UI 整合 | 待做 |
| 8 | 综合测试 | 待做 |

## 六、风险

| 风险 | 缓解 |
|---|---|
| Android 后台被杀导致桥端点不可达 | 前台服务（`WebServerService` 已有）+ 保活 |
| cpolar 域名变化 | 动态读 `origin`，禁硬编码 |
| DSH 端口随机 | 桥挂在 webServer 上，天然规避 |
| 手机内存 | 工具按需加载，不预建全部实例 |
| 协议随版本漂移 | 协议小 + 版本号 + 97 个回归用例 |
| 远端工具悄悄免审批 | `mcp__` 前缀强制继承审批规则 |
