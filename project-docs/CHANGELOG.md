# 变更日志 / CHANGELOG

## Unreleased

### 2026-11-19（第十一轮）— 首次 CI 编译验证：抓到 ZIP 快照的子模块陷阱

**背景**：用户给了自己的仓库 `GMYSJ/rikkahub-agent-gm` 与 PAT，
推到新分支 `verify/inbuilt-20261119` 触发云端编译（master 未动）。

**第一次 CI 失败**（run 44361664013），但**与内置代码无关**：
```
:llama-cpp:configureCMakeRelWithDebInfo[arm64-v8a] FAILED
CMake Error at CMakeLists.txt:27 (add_subdirectory):
  .../llama-cpp/native/llama.cpp  (目录为空)
```
根因 ZIP 快照的子模块目录是空的，`git add -A` 忽略了空目录，
gitlink（mode 160000）没进索引 → CI checkout 拿不到子模块内容。

**修复**：用 GitHub API 取上游 master 的子模块 SHA，
`git update-index --add --cacheinfo 160000,<sha>,<path>` 补回两个 gitlink
（llama.cpp `596a579`、material3 `6fd88eb`），提交 `7a8f27e` 重推。

**验证分支**：`verify/inbuilt-20261119`（master 完全未动）。
PAT 只用于临时 URL push，未写 `.git/config`、未进任何文件。

**第二次 CI：✅ success**（run 44362631085，约 18 分钟）
补回子模块 gitlink 后，`:app:assembleRelease` + R8 全部通过——
**内置代码通过了完整云端编译验证**。

master 分支完全未动（SHA `931345c`），改动只在 `verify/inbuilt-20261119`。

---

### 2026-11-19（第十轮）— 内置起点：远程节点数据层 + 设置入口

用户明确：最终形态是内置进 RikkaHub，桥只是过渡验证；移植目标 DSH Mobile → DSH-Go。

**新增**：
- `RemoteNode.kt`：节点模型；`toMcpServerConfig()` / `toOpenAIProvider()` 一键生成标准配置
- `RemoteNodeSync.kt`：幂等同步器（按 id 覆盖），把节点写进原生 mcpServers / providers
- `SettingRemoteNodePage.kt`：设置页（IP/端口/token/工具与模型开关）
- `PreferencesStore.kt`：`remoteNodes` 字段 + 独立 DataStore key
- `RouteActivity.kt` / `SettingPage.kt`：导航与入口

**关键取舍（避坑）**：
- 不新增 ProviderSetting 子类：那要改 5 处会编译失败的 `when`
  + ProviderConfigure 7 处，无编译链风险不可控。复用 OpenAI Provider + baseUrl。
- 不自动勾选 assistant：保留 `McpManager.kt:110` 的原有安全门。

**验证限制**：本机无 java/gradle，未编译。静态核对 10/10 符号 + 括号配对 + 导航/持久化各三处。

---

### 2026-11-19（第九轮）— 模型门面真机验证通过

**真实调用发现并修复**：
1. `Message.content` 必须是 `ContentBlock[]`（`dsh-llm/src/message.ts:143`），
   裸字符串导致流正常结束但 content 为空
2. `GenerateOptions` 需 `{provider, model}` 双字段；`model` 支持 `provider/model` 拆分
3. `LlmProviderInfo` 真实字段是 `{id, name}`（此前假设错）
4. system 消息转到 `GenerateOptions.system`；assistant/tool 因 source 结构未核实而明确拒绝

**验证结果（deepseek-official / deepseek-v4-flash）**：
- `/llm/v1/models` 返回 12 个真实 provider
- 非流式 ASCII → `PONG`、UTF-8 中文 → `收到`
- 流式 SSE → 文本帧 `OK` + usage finish + `[DONE]`

**排障经验**：`max_tokens` 太小时推理模型的 token 全被 reasoning 消耗，
正文还没开始就截断——completion_tokens>0 但 content 空时先加大配额。

**这两处修复在提交 `fd6df36`，测试总数维持 185 全绿。**

---

### 2026-11-19（第八轮）— 模型门面（OpenAI 兼容）+ 目标表述修正

**用户明确**：整个工程仍按基准主提示词推进，**最终形态是内置**；
唯一变化是移植目标 DSH Mobile → DSH-Go。当前桥只是过渡验证手段与接口层协议原型。
（已记入记忆与 PROJECT_STATUS）

**新增 `win-bridge/lib/llm.js`**：DSH StreamChunk ↔ OpenAI SSE 转换

DSH 的 7 种 chunk（`dsh-llm/src/types.ts:496-508`）映射：
- `text-delta` → `delta.content`
- `reasoning-delta` → 空 content（不泄漏思考文本，OpenAI 无标准字段）
- `tool-call-delta` → `delta.tool_calls` 增量
- `usage` 暂存、合并到 `finish` 帧
- `finish` → finish_reason（映射异常结束为 stop）

**新增两个端点**：
- `POST /llm/v1/chat/completions`（SSE 流式 + 非流式）
- `GET /llm/v1/models`（列 `ctx.llm.listProviders()` 真实路由，不虚构）

**实测源码发现并修正两处**：
- `LlmProviderInfo` 真实字段是 `{id, name}`，不是我假设的 `{provider, name}`
- `GenerateOptions` 需要 `{provider, model}` 两个字段；`provider/model` 形式需拆分

**inject 加 `llm`**（可选降级：缺 llm 服务时工具桥照常工作，模型端点返回 503）

**测试 155 → 184**（新增 test/llm.mjs 29 项），全绿。

> 注意：需重启 DSH 生效。

---

### 2026-11-19（第七轮）— 【真机暴露的严重 bug】工具 schema 被二次包装

**背景**：用户手机已能看到工具并实际调用。`/diagnostics` 显示 9 次调用中 8 次失败，
1 次 `memory_search` 成功。逐条复现真实错误后发现根因在桥侧。

**根因**：`ctx.tools.schemas()` 返回的 `parameters` **已经是编译后的标准 JSON Schema**
（`{type:'object', properties:{...}, required:[...]}`），但 `toolSchemaToWire()` 又调用了
`toolParametersToJsonSchema()` 把它当成字段映射再包一层，结果：

```
properties: { type:{}, properties:{}, required:{} }   ← 三个假字段
```

手机看到的是这三个假参数，于是给工具传错参数：
- `remote_list_hosts` 收到 `{query, scope}`，实际要求 `{}`
- 所有带参工具都调用失败

**这个 bug 只有真机调用才暴露**：工具能列出来、连接也通、MCP 握手正常，
纯离线测试全绿——因为 mock 里的 `parameters` 恰好是未编译的字段映射形状。

**修复**：`toolSchemaToWire()` 检测 object 根 JSON Schema 时原样透传，
只在确实是字段映射时才转换。新增回归测试。

**测试**：smoke 43→44，总计 154→155，全绿。

> 注意：修复需重启 DSH 生效。本轮重启已完成。

---

### 2026-11-19（第六轮）— 调用审计端点（区分「看见」与「调通」）

**背景**：用户报告手机能看到工具，但无法据此确认是否真的调用成功——
桥此前完全不写日志，`host.log` 里也没有桥的记录。

**新增 `GET /diagnostics`**
- 返回最近 20 次调用记录与统计
- `byVia` 分开统计 `native` / `mcp`，能看出手机走哪条路
- `totals` 成功/失败计数、`recent` 每次含工具名/耗时/来源 IP/错误码
- **只记元数据，不记参数与结果**（参数可能含路径、正文、凭据），有专门测试守这条

**重构**：`executeTool` 接收 `req` 与 `via`，两处调用点分别标注 `native` / `mcp`。

**测试**：`test/lan.mjs` 23 → 28，总计 149 → 154，全绿。

> 注意：该端点是新增代码，**需要重启 DSH 才生效**。
> 本轮刻意不重启——用户正在用手机调用，不能打断。

---

### 2026-11-19（第五轮）— 局域网监听打通，手机可接入

**项目定位调整（用户确认，方向 A）**

用户确认 DSH Go 与 RikkaHub 两个都用，并选择方向 A：

| | RikkaHub | DSH Go |
|---|---|---|
| 强在 | Android 系统能力（Shizuku/截屏/短信/通知） | 遥控电脑 DSH（100+ UI 功能点已完成） |
| 定位 | 手机端 Agent | 电脑端 DSH 的手机遥控器 |

**结论**：不在 RikkaHub 里重造 DSH 远程 UI，而是用桥把两者打通。

**新增 `win-bridge/lib/lan.js`**

DSH Desktop 的 webServer 只绑 `127.0.0.1`，且拒绝通配地址，
所以桥另起一个**独立局域网监听**：

- 只绑具体网卡地址（`192.168.1.3`），**拒绝 `0.0.0.0` / `::` / `*`**
- 拒绝回环地址（绑回环等于没做）
- **强制 `lan.token`（≥16 字符）**，无 token 拒绝启动
- `lan.token` 与主 `token` 是**两套独立凭据**，互不通用
- 与主入口**共用同一份 handler**，行为必然一致
- 启动失败只记警告，不影响主通道

**重构**：`bridgeHandler` 改为 `makeBridgeHandler(checks)` 工厂，
让两个入口共用实现但用不同鉴权；`preflight` 支持注入鉴权器。

**测试 126 → 149**

- 新增 `test/lan.mjs`（23 项）
- 真实 DSH 局域网验证 17 项全绿

**已知变化**：`install_bundle` 时 pnpm 改写 bundles，去掉了 `dsh-go-workspace`。
经追查确认这是用户早已弃用的插件（3443 在会话开始前就不在监听），**不恢复**，
可从 `package.json.bak-bridge-20261119-002539` 恢复。

---

### 2026-11-19（第四轮）— 装 Git + 桥落地真实 DSH + 17 项端到端验证

**1. 安装 Git（便携版，不污染系统）**

- MinGit `2.56.1-64-bit` 解压到 `D:\AAAdeepseek\工作区\tools\git`
- 已加入用户 PATH（`tools\git\cmd`），新 shell 直接可用
- 仓库初始化于 `repos/rikkahub-agent-gm`，基线提交 `c4e6e87`，跟踪 **1947 个文件**，`.git` 47 MB
- 仓库级身份 `rikkahub-agent-gm dev <dev@localhost>`，不碰全局配置
- `core.autocrlf=false`（避免 CJK 与二进制被改写）、`core.longpaths=true`

**2. 桥装进 desktop profile 并启用**

- `plugin_manager install_bundle` → `application: applied`
- 安装后**回归核对**：原有 15 个 bundles 一个不少（现 16），
  `im-qqbot` 的 `appId`/`appSecret` 未动，WorkBuddy 文件时间戳未变
- 启用在 profile `cordis.patch.yml` 里按 id 覆盖 bundle 的 `enabled: false`
- 生成 64 字符随机 token，**只存 profile，不进 git**

**3. 真实 DSH 环境端到端验证（17 项全绿）**

重启后端口 `61412`，逐项验证：

| 关键证据 | 结果 |
|---|---|
| `/tools` 从真实 `ctx.tools` 读到工具 | ✅ **18 个** |
| MCP `initialize` / `tools/list` / `tools/call` | ✅ 全通 |
| `memory_list` 真实执行 | ✅ 返回记忆库数据 |
| **双向闭环**：DSH → 桥 → 远端节点 → 回传 | ✅ `{"battery":87,"detail":true}` |
| 401 / 403 / 508 / 防自我回显 | ✅ 真实环境全部生效 |

**4. 测试中发现的真实缺陷**

首次跨节点测试用 `baseUrl` 指向桥自己，回调失败（`unknown tool "sim_battery"`）。
判读后确认这不是桥的 bug，而是测试设计错误 —— 桥回调过去用的是**原始工具名**，
而自己从未注册过裸名 `sim_battery`。改用真实两个节点后通过。

这个"失败"反而验证了一条正确设计：**桥存储的是 `(nodeSlug, 原始工具名)`**
而非限定名，所以远端节点只需实现自己的 `/tools/call`，
**不需要知道 `mcp__` 前缀规则**。

**5. 新增待办（需要真机或用户操作）**

- 真机验证需手机侧操作，本机无 adb
- 桥当前只能经 `127.0.0.1` 访问；手机要用必须走移动网关反代或 `dsh-go-workspace` 的 3443

---

### 2026-11-19（第三轮）— 增加 MCP 兼容端点，手机侧可零代码接入

**新增 `win-bridge/lib/mcp.js`** — 最小 MCP（Streamable HTTP）服务端实现

实现要点：不依赖任何 MCP SDK，纯 JSON-RPC 逻辑，约 250 行，可脱宿主测试。

支持：`initialize`、`notifications/initialized`、`notifications/cancelled`、
`ping`、`tools/list`、`tools/call`，以及 JSON-RPC 批量请求。

不实现：resources、prompts、sampling、roots、progress、服务端推送流
（`GET /mcp` 返回 405，请求这些方法得到 `-32601`）。

**为什么值得做**：RikkaHub 已有完整 MCP 客户端
（`McpSessionRegistry.kt:466-478` 支持 `StreamableHttpClientTransport`），
所以手机侧指向 `<base>/mcp` 即可，**不需要写任何 Kotlin 代码**。
私有协议端点仍保留，用于 `/register` 这类 MCP 表达不了的反向注册。

**错误语义（容易做错的地方）**：工具执行失败返回 `result.isError=true`，
**不**打成 JSON-RPC error —— 否则客户端会误判为协议故障。

**重构**：抽出 `executeTool()`，让原生 `/tools/call` 与 MCP `/mcp` 共用同一执行路径，
消灭重复代码，并确保两者都走 `ctx.tools.execute()`（**不绕审批**）。

**测试**：新增 `test/mcp.mjs`（29 用例）。
总计 **43 + 17 + 25 + 12 + 29 = 126 个用例全部通过**。

**文档**：`PROTOCOL_SPEC.md` 增 2.1/2.2 两节；
`win-bridge/README.md` 补「手机侧怎么接」；
`INDEX.md` 增加「路径 A（MCP，零代码）/ 路径 B（Kotlin）」两条建议路线。

---

### 2026-11-19（第二轮）— 阶段 1 完成

**新增 4 份阶段 1 文档**

- `TOOL_BRIDGE.md` — 工具代理层：`Tool` 真实结构、5 条装配链路、审批体系 5 组件、
  `mcp__` 前缀为何是安全机制、双向流程、防循环/防重/防丢
- `MODEL_ROUTING.md` — 统一模型：两端模型体系、`UnifiedModel` 数据模型、
  uid 命名与去重规则、三个量化方向、认证隔离、模型下线处理
- `SECURITY_MODEL.md` — 六层防御、威胁模型、`NO_ALWAYS_ALLOW` 完整 10 项、
  凭据三类分清、**已实现 vs 未实现诚实清单**
- `DATA_MIGRATION.md` — 数据结构改动点、`Settings` 逐字段存储的迁移利好、
  Workspace 四类路径边界、回滚方案、发布前检查清单

**修正上一轮的一处错误结论**

上一轮我声称「电脑是 OpenAI 兼容端点，手机侧加个 baseUrl 即可，零代码」。
**这是错的**，已核实纠正：

- DSH **不对外提供** `POST /v1/chat/completions`
- 全仓出现的 `/v1/models` 是 `dsh-llm-pi-ai/src/discovery.ts` 里**出站**去问
  上游厂商的客户端代码，不是本地端点
- 正确路径：桥要实现 `/llm/v1/chat/completions` 门面，之后手机侧
  才能用 `ProviderSetting.OpenAI(baseUrl=桥)` 或 `Model.providerOverwrite`

**本轮新核实的源码事实**

| 事实 | 证据 |
|---|---|
| `Settings` **不整体序列化**，每字段独立 `stringPreferencesKey`，读取处用 `?: 默认值` | `PreferencesStore.kt:244-280`、`:337-376` |
| → 新增字段**天然向后兼容**，不需要迁移脚本 | 同上 |
| `JsonInstant` 配 `ignoreUnknownKeys=true` + `encodeDefaults=true` | `utils/Json.kt:7-12` |
| `providerOverwrite` 被 `GenerationLoop.kt:506` 等 11 处使用，默认生效 | `findProvider` 调用点清单 |
| 例外：`ModelList.kt:335` 用 `checkOverwrite=false`（列表分组用，故意为之） | `ModelList.kt:335` |
| `WebApiModule` 的 `route("/api")` **只占 `/api` 前缀**，桥用独立路径不冲突 | `WebApiModule.kt:140-141` |
| 已有 `authenticate("auth-jwt")` 分支，桥可复用同一套 JWT | `WebApiModule.kt:170-186` |
| `LocalToolOption` 是 sealed class + 50 多个 `data object`，权限敏感项独立开关 | `LocalTools.kt:132-207` |
| → 桥的工具白名单可**直接复用**其开关语义 | 同上 |
| `WorkspaceFileSystem` 是实例方法，每次收 `root: File`，以 `files/` 为根安全 | `WorkspaceFileSystem.kt:12-35` |
| `NO_ALWAYS_ALLOW` 精确 **10 项**（脚本逐行枚举核对，非估算） | `ToolApprovalDefaults.kt:262-293` |
| `Tool` 有 `systemPrompt` 字段；`needsApproval` 是 `(JsonElement)->Boolean` | `Tool.kt:12-19` |
| `Provider.streamText()` 返回 `Flow<StreamChunk>`（不是 `stream`） | `Provider.kt:29-33` |
| `ProviderManager.getProviderByType()` 穷尽分派 9 种 `ProviderSetting` | `ProviderManager.kt:51-64` |

**阶段状态**

- 阶段 0 ✅ / 阶段 1 ✅ / 阶段 3 🔶（DSH 侧完成，126 用例通过，手机侧未开始）

---

### 2026-11-19（第一轮）— 阶段 3 开工：DSH 侧双向工具桥落地

**新增 `win-bridge/`（Host 插件包，97 个测试用例全绿）**

- `lib/protocol.js` — 协议常量、trace 解析、跳数预算（循环防护）、工具名限定
- `lib/schema.js` — DSH `ParameterSchemaSpec` ↔ 标准 JSON Schema 双向转换
- `lib/client.js` — 出站调用，DSH 作为客户端反向调手机工具
- `lib/index.js` — 插件入口，5 个 HTTP 端点 + 远端工具注册
- `test/smoke.mjs`(43) / `test/client.mjs`(17) / `test/e2e.mjs`(25) / `test/host-load.mjs`(12)

**架构前提修正（重要）**

- 实测证伪「DSH 可作 MCP Server」：运行时只打包 `@modelcontextprotocol/client`，
  `server`/`node`/`sdk` 未打包，全仓无自建 MCP 服务端实现
- 实测发现 DSH 有完整的 **Typert Remote** RPC（`POST /api/<ns>/<method>` + `WS /api/remote.mux`），
  但 `/connect` 换出的 Cookie 是**完整 owner 权限**，无降权
- 改用挂在 `ctx.webServer` 上的极简 HTTP 桥：自动继承 DSH 端口，无需端口发现

**实测记录的两个真实坑**

1. `defineTool` 的 `parameters` 是**逐字段映射**，不是 `{type:'object',properties}` 包裹结构。
   传包裹形式会报 `parameters.type must be a value schema object`，整个工具注册失败。
2. `required` 在 DSH spec 里是**字段级 `required: true`**，在标准 JSON Schema 里是**父级数组**，
   两侧都要搬移，漏做则模型把必填参数当可选。

**新增文档**

- `project-docs/PROTOCOL_SPEC.md` — 完整协议规格（含选型对比与诚实的能力边界）

**RikkaHub 源码审计新结论**

- `ChatToolFactory.createTools()` **是死代码**（全仓无调用点），
  真正的工具装配在 `ChatService.kt:1721-1804`（主链路）、`:1449-1485`（rerun）等 5 条链路
- `Tool` 数据类有 `systemPrompt` 字段（原文档漏记）
- `needsApproval` 是 `(JsonElement) -> Boolean`，不是布尔字段
- Android 侧已有可用的 Ktor HTTP Server 宿主（`web/Entry.kt:18-43` 的 `startWebServer`）

---

### 2026-11-18 — 项目初始化

- 创建项目目录 `D:\AAAdeepseek\工作区\repos\rikkahub-agent-gm`
- 创建 `project-docs/` 骨架：PROJECT_STATUS / BLOCKERS / DECISIONS / TEST_REPORT / CHANGELOG
- 确认环境基线：无 java/adb/gradle/git，构建走 GitHub Actions（JDK 21）
- 确认仓库已有 MCP Kotlin SDK 0.15.0 + Ktor 3.5.2
- 记录 3 个阻塞项（无 Git、无本地编译链、无 ADB 通道）
- 阶段 0 完成：PROJECT_AUDIT / FEATURE_MATRIX / COMPATIBILITY_REPORT / ENVIRONMENT_REPORT
- 阶段 1 部分完成：ARCHITECTURE.md
