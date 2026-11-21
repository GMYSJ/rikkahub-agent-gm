# 决策记录 / DECISIONS

> 每个影响架构或长期维护的选择记一条：日期 / 决策 / 理由 / 备选方案。

## D-001 以 GitHub Actions 云端构建 APK

**日期**：2026-11-18

**决策**：APK 构建全部走 GitHub Actions，CI 使用 JDK 21。不在本机安装 Android SDK / JDK / Gradle。

**理由**：
- 本机无 java / adb / gradle，且无任何包管理器，安装成本高
- AGP 9.3.1 要求 JDK 21，本机 15.7GB 内存跑 Gradle 也紧张
- 仓库已有 `.github/workflows/build-android.yml`，可复用

**备选**：本地安装 SDK 到 `D:\Android\Sdk`（已否决，除非用户明确要求）

---

## D-002 ~~双向桥复用 MCP + Ktor，不新建传输层~~ **已被 D-004 取代**

**日期**：2026-11-18 ／ **作废日期**：2026-11-19

**原决策**：手机端与电脑端的能力互通，基于仓库已有的 MCP Kotlin SDK 与 Ktor 实现。

**作废原因**：该决策建立在一个未经验证的假设上 ——「DSH 侧可以当 MCP Server」。
2026-11-19 实测证伪（见 D-004）。

**保留部分**：手机侧仍然复用 Ktor（`web/Entry.kt` 的 `startWebServer` 已就位），这一点没变。

---

## D-003 不修改 DSH 核心宿主与 app.asar

**日期**：2026-11-18

**决策**：Windows 侧改动只通过 DSH 插件、扩展 API、独立伴生服务实现。

**理由**：
- app.asar 是打包文件，改动风险高且升级会覆盖
- 用户现有 13 个插件与 WorkBuddy 登录状态必须保全

**备选**：无（红线）

---

## D-004 双向桥改用自制极简 HTTP 协议，不用 MCP

**日期**：2026-11-19

**决策**：DSH 侧不实现 MCP Server。两端共用一个自制的、可版本化的极简 HTTP 协议，
挂在 DSH 自己的 `ctx.webServer` 上与手机侧对等通信。

**理由**（全部有实测证据）：

1. **DSH 没有 MCP Server 能力**——运行时只打包 `@modelcontextprotocol/client`，
   `server`/`node`/`sdk` 三个包不存在；全仓无 `createMcpServer`/`serveMcp` 实现。
   「DSH 当 MCP Server」这条路**不存在**，不是「难做」。
2. **DSH 的 Typert Remote RPC 不适合直接给手机**——`/connect` 换出的 Cookie
   就是完整 owner 权限（`rpc-host.ts:169-173` 硬编码 `principal:{kind:'owner'}`），
   没有细粒度降权；且协议是随版本漂移的内部约定，不是对外契约。
3. **挂在 `ctx.webServer` 上自动继承端口**——规避了 DSH 每次重启换端口、
   又没有 portfile 的麻烦（`setup.json` 的 `upstreamOrigin` 会过期）。
4. **协议小到可以完整测试**——126 个用例覆盖到真 HTTP 服务器与真实 `defineTool`。

**代价（诚实记录）**：
- 需要自己维护协议与两端实现
- v1 能力窄（只有工具面），会话/消息/文件传输要另做
- 不做版本协商（只在 header 带版本号）

**备选方案与否决理由**：
- 自建 MCP Server 包 DSH → ❌ 服务端能力不存在
- 独立 MCP Server 进程反调 DSH `/api` → ⚠️ 多一层进程 + 多一份 owner 凭据 + 多一跳延迟，只在「已有别家 MCP 客户端」时才值
- 直接反代 DSH Web GUI（现有 `dsh-mobile-app` 做法）→ ✅ 保留作为**兜底通道**，但对「融合进 RikkaHub 原生 UI」没有帮助

---

## D-005 远端工具名强制 `mcp__<node>__<tool>` 前缀

**日期**：2026-11-19

**决策**：所有从远端注册进来的工具，名字一律加 `mcp__<nodeSlug>__` 前缀。

**理由**：这不是命名美化，是**安全机制**。

RikkaHub 的审批体系里有一条现成规则（`ToolApprovalDefaults.kt:304-305`）：

```kotlin
requiresApproval = name in ALWAYS_ASK || name.startsWith("mcp__")
```

用这个前缀，远端工具就**自动继承**「默认要求人工批准」的保护。
否则要么得改 `ToolApprovalDefaults`，要么远端工具会悄悄变成免审批工具。

**备选**：自定义 `remote__` 前缀（否决：要额外改审批表，且容易漏）

---

## D-006 桥默认 `enabled: false`

**日期**：2026-11-19

**决策**：插件装上后不挂任何端点，必须用户显式配置 `enabled: true` 才启用。

**理由**：端点一旦挂上，在未配 token 时就是局域网可达的攻击面。
默认安全的代价只是多一步配置，而默认开放的代价可能是不可逆的。

**配套**：可选 `token` 配置，设置后除 `/health` 外所有端点要求 `Authorization: Bearer`。

---

## D-007 工具执行必须走 `ctx.tools.execute()`，不得直连底层

**日期**：2026-11-19

**决策**：桥执行工具时调用 DSH 自己的 `ctx.tools.execute({ calls, signal })`，
而不是自己去调工具实现。

**理由**：走这个入口，DSH 的整条流水线照常生效：

```
tools/pre-execute → guards → tools/execute → tools/post-execute → finalizeContent
```

包括 `HardlineCommandGuard` 和用户审批。**桥不是审批旁路** ——
这是主提示词「工具权限被远程调用绕过」这条禁令的直接落实。

**备选**：直接调 `definition.execute()`（否决：绕过全部守卫与审批）

---

## D-008 手机侧工具白名单复用 `LocalToolOption` 开关语义

**日期**：2026-11-19

**决策**：桥暴露哪些手机工具，**不另建白名单机制**，直接复用
`LocalTools.getTools(options)` 已有的 `LocalToolOption` 开关。

**理由**：

已核实 `LocalToolOption` 是 `@Serializable sealed class`，50 多个 `data object`，
且**权限敏感项本来就是独立开关**（`LocalTools.kt:174-205`）：

```kotlin
@SerialName("sms_inbox")  data object SmsInbox    : LocalToolOption()
@SerialName("contacts")   data object Contacts    : LocalToolOption()
@SerialName("keystore")   data object Keystore    : LocalToolOption()
@SerialName("camera_photo") data object CameraPhoto : LocalToolOption()
@SerialName("nfc")        data object Nfc         : LocalToolOption()
```

用户没开的工具，`getTools()` 根本不会返回 —— 白名单问题一半自动解决。

**额外好处**：`LocalToolOption` 有一套**宽松反序列化**机制
（`LocalTools.kt:209-212`），不认识的枚举项会被丢弃而不是让整个解码崩掉。
装上不同版本的手机不会因为工具项不匹配而炸。

**代价**：桥的「可用工具集」会随用户在设置里勾选的工具变化，
需要 UI 上讲清楚（可用工具 = 用户已开启的本地工具的子集）。

**备选**：桥自带一份独立白名单（否决：两处配置会漂移，且容易漏掉新工具）

---

## D-009 桥的模型门面用 OpenAI 兼容格式，而不是自定义协议

**日期**：2026-11-19

**决策**：桥为「电脑模型给手机用」提供的端点，采用 OpenAI 的
`POST /v1/chat/completions`（SSE）格式，而不是自定义 `/llm/stream`。

**理由**：

1. 手机侧已有完整的 `OpenAIProvider`，**零代码**可用
2. 若走自定义协议，手机侧要新写 `Provider` 子类 → **10 处改动**，
   其中 3 处是**会编译失败的穷尽 `when`**
   （`PreferencesStore.kt:627-663`、`ChatboxImporter.kt:671-688`、
   `CherryStudioProviderImporter.kt:126-134`），外加 `ProviderConfigure.kt` 的 7 个 `when`
3. OpenAI 格式是事实标准，未来接第三方客户端也顺

**代价**：需要做两套工具 schema 互转（OpenAI `tools` ↔ DSH `ToolSchema`），
且流式分片要按 SSE 编码（`data: {...}\n\n` + `[DONE]`）。

**重要前提**：DSH **本身不提供**这个端点（已核实）。
`/v1/models` 出现的地方是 `dsh-llm-pi-ai/src/discovery.ts` 的**出站**代码。
所以这层门面**必须由桥自己实现**，不是「加个 baseUrl」就行。

**备选**：自定义 `/llm/stream`（否决：手机侧改动面太大）
