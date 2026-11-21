# 开工索引 / INDEX

> **新对话第一件事：读这个文件。**
> 项目根：`D:\AAAdeepseek\工作区\repos\rikkahub-agent-gm`
> 主提示词：`D:\AAAQQ文件\RikkaHub_DSH_融合工程总提示词-1.md`

## 状态速览

| 项 | 状态 |
|---|---|
| 阶段 | **0 完成 · 1 完成 · 3 已开工（DSH 侧已落地）** |
| 源码 | ✅ 已下载落位（ZIP 快照，无 `.git`） |
| 审计 | ✅ 已完成，且有**重大修正** |
| 架构 | ✅ 已按实测重写（`ARCHITECTURE.md`） |
| 协议 | ✅ `PROTOCOL_SPEC.md` 完成 |
| 代码 | ✅ `win-bridge/` 插件，**126 个测试用例全绿** |
| MCP 端点 | ✅ 已实现（手机可零代码接入） |
| 阻塞 | ⚠️ 无 git、无本地编译链、无 ADB（均不阻塞设计） |

## 必读顺序

1. `PROJECT_STATUS.md` — 进度与待办（**含架构修正记录**）
2. `PROTOCOL_SPEC.md` — 协议规格（**实现以此为准**）
3. `ARCHITECTURE.md` — 总体架构（已按实测重写）
4. `TOOL_BRIDGE.md` — 工具代理怎么接
5. `MODEL_ROUTING.md` — 统一模型怎么落地
6. `SECURITY_MODEL.md` — 安全边界与已知缺口
7. `DATA_MIGRATION.md` — 数据结构改动与回滚
8. `BLOCKERS.md` — 当前障碍
9. `PROJECT_AUDIT.md` — 源码审计（有若干结论已被后续实测修正）
10. `FEATURE_MATRIX.md` / `COMPATIBILITY_REPORT.md` — 能力与版本边界
11. `DECISIONS.md` — 已定决策，别推翻
12. `TEST_REPORT.md` — 测试怎么跑、覆盖了什么
13. `CHANGELOG.md` — 变更历史

## 四个最重要的技术结论

### 1. ⚠️ DSH 不能当 MCP Server（原架构前提已证伪）

实测：运行时只打包 `@modelcontextprotocol/client`，`server`/`node`/`sdk` **未打包**，
全仓无任何自建 MCP 服务端实现。**这条路不存在。**

已改用自制极简 HTTP 协议，挂在 DSH 自己的 `ctx.webServer` 上 —— 顺带解决了端口随机变化的问题。

### 2. DSH 的 Typert Remote RPC 不适合直接给手机

它有完整能力（`POST /api/<ns>/<method>` + `WS /api/remote.mux`），但：
- `/connect` 换出的 Cookie 是**完整 owner 权限**，无降权（`rpc-host.ts:169-173`）
- 协议是随版本漂移的内部约定，不是对外契约

### 3. 工具执行走 `ctx.tools.execute()`，桥不是审批旁路

这是安全红线。走这个入口，`pre-execute → guards → execute → post-execute` 全部照常生效，
包括 `HardlineCommandGuard` 与用户审批。

配套：远端工具名强制 `mcp__<node>__<tool>` 前缀，直接继承 RikkaHub
`ToolApprovalDefaults.kt:305` 的「`mcp__` 前缀默认要人工批准」规则。

### 4. RikkaHub 侧的真实注入点不是 `ChatToolFactory`

`ChatToolFactory.createTools()` **是死代码**（全仓无调用点）。
真正生效的 5 条链路：`ChatService.kt:1721-1804`（主）、`:1449-1485`（rerun）、
`:973-980`、`CronJobWorker.kt:368-375`、`WorkflowEngine.kt:213`。

最干净的扩展点是 `LocalTools.getTools()`（`LocalTools.kt:720-723`）—— 一次覆盖全部 5 条。

## 环境红线（违反会出事）

| 红线 | 说明 |
|---|---|
| DSH 重启 | 只能 `schtasks /Run /TN "DSH静默重启"` |
| pnpm add/remove | 会清空 `dsh.profile.bundles`，装完必核 |
| `cordis.patch.yml` | 新增行必须 `- insert:` |
| `im-qqbot` 配置 | 只能 key 级替换，禁止整体重序列化 |
| DSH 端口 | 每次重启变（`--port 0`），**无 portfile**，禁止硬编码 |
| `app.asar` | 是打包文件；PowerShell 的 `Get-ChildItem`/glob 无法遍历，要用 DSH 自带 Electron-as-Node |
| PowerShell 读 UTF-8 | **必须加 `-Encoding UTF8`** |
| 插件安装 | 不要手工写 profile 的 `package.json`/`cordis.patch.yml`，用 `install_bundle` |

## 本机工具链实况

```
java    ❌    adb     ❌    gradle  ❌    git     ❌
winget  ❌    scoop   ❌    choco   ❌
node    ✅ v24.22.1     pnpm ✅ 11.28.5
python  ✅ D:\Python311\python.exe
NDK r28 ✅ (pd2243-work，仅 C/C++，与本工程无关)
```

**构建走 GitHub Actions，JDK 21。**

## 建议的下一步

### 路径 A（推荐，最快闭环）：手机走 MCP，零代码

桥已经有 **MCP Streamable HTTP 端点**（`<base>/mcp`），而 RikkaHub 已有完整
MCP 客户端（`McpSessionRegistry.kt:466-478` 支持 `StreamableHttpClientTransport`）。

所以**手机侧一行代码都不用写**：

```
RikkaHub → 设置 → MCP → 添加服务器
  transport: streamable-http
  url:       https://<电脑>:<port>/dsh-mobile-bridge/mcp
  headers:   Authorization: Bearer <token>
→ 务必在 Assistant → MCP 里勾选该 server（否则工具不出现）
```

需要做的只有：
1. 把 `win-bridge` 装进 profile（`install_bundle`）
2. 把 `enabled` 改成 `true`，配一个 `token`
3. 重启 DSH（走 `schtasks /Run /TN "DSH静默重启"`）
4. 手机填配置，实测调一个只读工具

**这条路能立刻验证「手机调电脑」通不通**，风险最低。

### 路径 B：手机侧 Kotlin 实现（能力更全）

只有当需要 MCP 表达不了的东西时才做：

1. 在 `web` 模块复用 `startWebServer` 挂桥端点。
   已核实 `route("/api")` **只占 `/api` 前缀**，桥用独立路径不冲突；
   且已有 `authenticate("auth-jwt")` 分支可直接复用。
2. 手机侧工具执行走 `LocalTools.getTools()` + `ToolApprovalDefaults`（**不要绕过审批**）。
   `LocalToolOption` 是 sealed class + 50 多个开关，权限敏感项本就独立 ——
   **白名单直接复用它的语义**。
3. 实现 `/register` 反方向（让电脑调手机工具）。

## 两个必须避免的错误路径

**❌ 不要试图让 DSH 当 MCP Server 的「现成能力」。**
运行时根本没打包 `@modelcontextprotocol/server`，DSH 也没有自建实现。
桥里的 MCP 端点是**我们自己写的最小实现**（`lib/mcp.js`），不是复用了什么。

**❌ 不要以为「加个 baseUrl 就能用电脑模型」。** DSH **不对外提供** OpenAI 兼容端点。
`/v1/models` 出现在 `dsh-llm-pi-ai/src/discovery.ts` 里，那是**出站**去问上游厂商的代码。
正确路径见 `MODEL_ROUTING.md` 四节：桥要实现 `/llm/v1/chat/completions` 这层门面，
之后手机侧才能用 `ProviderSetting.OpenAI(baseUrl=桥)` 或 `Model.providerOverwrite`。

（`providerOverwrite` 这条路**确实零代码** —— 已核实它被 `GenerationLoop.kt:506`
等 11 处使用且默认生效；但前提是桥先把那个端点做出来。）
