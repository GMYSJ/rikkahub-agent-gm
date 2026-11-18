# 项目状态 / PROJECT STATUS

> 每次会话开始先读本文件与 `BLOCKERS.md`，不要重复已完成工作。
> 每次阶段完成必须更新本文件。

## 当前阶段

**阶段 0 完成 · 阶段 1 完成 · 阶段 3 DSH 侧已装机并实测通过 · 局域网通路已打通**

> **2026-11-19 重大进展**：
> 1. 桥已装进 desktop profile 并启用，真实 DSH 上端到端验证通过
> 2. **新增局域网监听**，手机已接入（`192.168.1.3:61420`）
> 3. 测试 126 → **155 个用例**
> 4. **真机验证通过**：手机 Agent 经 MCP 真实执行了电脑工具
>    （`session_search` 197ms、`leak_guard`×4、`memory_entity` 均成功）

### 项目目标（用户 2026-11-19 再次明确）

**整个工程仍按基准主提示词推进，唯一变化是移植目标：**
**DSH Mobile（saya-ch/dsh-mobile）→ DSH-Go（ccch1mneyyy/dsh-Go）。**

**最终形态仍然是「内置」** —— 把 DSH 的远程/工具/模型能力做进 RikkaHub，
不是让用户长期依赖外部桥插件 + 手动配 MCP。

当前 `win-bridge` 的定位是**过渡验证手段 + 接口层协议原型**
（工具面已真机跑通），**不能据此判定「不需要内置」**。

分寸把握（用户确认的方向 A）：
- 不重造 DSH-Go 已完成的 100+ 远程 UI（那是追一个已完成的东西）
- RikkaHub 专注 Android 系统能力（Shizuku/截屏/通知）
- 桥作为接口层与协议验证场
- **最终把这些能力内置进 RikkaHub 原生 UI**

理由（已核实）：

| 能力 | RikkaHub | DSH Go |
|---|---|---|
| Shizuku / 截屏 / 点按 / 无障碍 | ✅ | ❌ |
| 短信 / 通讯录 / 通知 | ✅ | ❌ |
| 自建 Agent 引擎 | ✅ | ❌（用 DSH 引擎） |
| 手机本机跑 DSH | ❌ | ✅ |
| 遥控电脑 DSH | 本桥提供 | ✅ 已完成（100+ UI 功能点） |

**结论：不在 RikkaHub 里重造 DSH 的远程 UI**（那是追一个已完成的东西），
而是让 RikkaHub 的 Agent 能调用电脑 DSH 的能力。桥就是这个接口层。

## 项目目标

以 RikkaHub Agent 为唯一移动端 UI 主体，融合 DSH 的双向 Agent 能力、工具、模型与工作区。
详见主提示词 `D:\AAAQQ文件\RikkaHub_DSH_融合工程总提示词-1.md`。

## 重要：架构前提已被实测修正（2026-11-19）

原 `ARCHITECTURE.md` 假定「两端都用 MCP，DSH 侧当 MCP Server」。**该前提经实测证伪**：

| 原假设 | 实测结论 | 证据 |
|---|---|---|
| DSH 可作 MCP Server | ❌ **不存在此能力** | 运行时只装了 `@modelcontextprotocol/client`；`server`/`node`/`sdk` 未打包；全仓无自建服务端 |
| 手机侧需自建 MCP Server | ⚠️ 仍可做，但不是最短路径 | — |
| `ChatToolFactory.createTools()` 是注入点 | ❌ **是死代码** | 全仓无调用点；真正生效的是 `ChatService.kt:1721-1804` 等 5 条链路 |
| DSH 无 HTTP API | ❌ 有完整的 Typert Remote RPC | `dsh-api-gateway` + `dsh-api-remotes` + `*-controller` |

**新方案**：自制极简 HTTP 桥（`win-bridge/`），挂在 DSH 自己的 `ctx.webServer` 上。
好处：自动继承 DSH 端口（不需要端口发现）、协议小到可完整测试、两端实现必然对称。

详见 `PROTOCOL_SPEC.md`。

## 已完成

### 阶段 0：环境与源码审计 ✅

- [x] 创建项目目录、管理文档
- [x] 下载 RikkaHub 源码（master ZIP，44.4 MB）
- [x] 审计 `ai/` `app/` `workspace/` `web/` 模块
- [x] 审计 `.github/workflows/build-android.yml`（JDK 21 已就位）
- [x] 审计 DSH Mobile 0.2.1 桌面插件（内嵌完整 `dsh-mobile` vendor 源码 + 协议文档）
- [x] 输出 PROJECT_AUDIT / FEATURE_MATRIX / COMPATIBILITY_REPORT / ENVIRONMENT_REPORT

### 阶段 1：统一架构设计 ✅

- [x] `ARCHITECTURE.md` — **已按实测重写**（修正 DSH-as-MCP-Server、ChatToolFactory 注入点两处硬错误）
- [x] `PROTOCOL_SPEC.md` — 协议 v1 完整规格
- [x] `TOOL_BRIDGE.md` — 工具代理层设计
- [x] `MODEL_ROUTING.md` — 统一模型体系设计
- [x] `SECURITY_MODEL.md` — 威胁模型、六层防御、已知缺口
- [x] `DATA_MIGRATION.md` — 数据结构改动与回滚方案

### 阶段 3：DSH 侧桥 ✅ 已落地并有测试

已实现 `win-bridge/`（Host 插件包，可 install_bundle）：

| 文件 | 职责 |
|---|---|
| `lib/protocol.js` | 协议常量、trace 解析、**循环防护**、工具名限定 |
| `lib/schema.js` | DSH spec ↔ 标准 JSON Schema 双向转换（含 required 搬移） |
| `lib/client.js` | 出站调用（DSH 当客户端去调手机工具） |
| `lib/mcp.js` | **MCP Streamable HTTP 兼容端点**（手机可零代码接入） |
| `lib/index.js` | 插件入口：6 个端点 + 工具注册 |
| `test/` | 5 个套件，**126 个用例全部通过** |

关键设计：工具执行走 `ctx.tools.execute()`，**不是审批旁路**；
远端工具名一律 `mcp__<node>__<tool>`，继承 RikkaHub 默认人工审批。

**MCP 端点是个重要收益**：RikkaHub 已有完整 MCP 客户端
（`McpSessionRegistry.kt:466-478` 支持 `StreamableHttpClientTransport`），
所以手机侧指向 `<base>/mcp` 就能用，**不需要写任何 Kotlin 代码**。

### 阶段 3 当前实测状态 ✅

桥已装进 desktop profile（`install_bundle`，`application: applied`），
重启后在**真实 DSH** 上验证（两轮合计 34 项全绿）：

**第一轮（回环，17 项）**
- `/tools` 从真实 `ctx.tools` 读到工具
- MCP 握手 → `tools/list` → `tools/call` 全链路通
- `memory_list` 真实执行并返回记忆库数据
- **双向闭环**：DSH → 桥 → 远端节点 → 回传 `{"battery":87}` ✅
- 安全防护（401/403/508/防自我回显）全部生效

**第二轮（局域网，17 项）**
- `192.168.1.3:61420` 监听成功，**只绑具体网卡，未绑 0.0.0.0**
- `/health` 200、无 token 401、带 LAN token 200（**29 个工具**）
- **主 token 在 LAN 端口无效** → 凭据隔离生效
- 局域网 MCP 完整握手 + `tools/call` 真实执行成功
- 连续 5 次调用 5/5 成功
- 跳数防护 508、`mcp__` 拦截 403 在 LAN 端口同样生效

### 已知变化：`dsh-go-workspace` 已从 bundles 移除

**原因**：`install_bundle` 时 pnpm 改写 `package.json`，把 `dsh-go-workspace` 从
`dsh.profile.bundles` 去掉了（这是本项目记录的已知风险）。

**判断：不需要恢复。** 依据：
- 用户已明确「换了这个新插件（ds-harness-remote），原来那个弃用了」
- 本次会话**第一次核查时 3443 端口就已经不在监听**
- 两者同脉网关、抢 3443 与 `mobile-access` 状态，旧包明写不可并存

**但记录在这**：如果以后想换回，从
`package.json.bak-bridge-20261119-002539` 恢复 bundles 即可。

## 内置进展（阶段：数据层 + 设置入口已落地，待编译验证）

按用户 2026-11-19 的明确要求，开始把桥验证过的协议**内置进 RikkaHub**。

**已落地代码**：

| 文件 | 作用 |
|---|---|
| `data/remote/RemoteNode.kt` | 节点数据模型；一键生成 `McpServerConfig.StreamableHTTPServer` + `ProviderSetting.OpenAI` |
| `data/remote/RemoteNodeSync.kt` | 幂等同步器：按 id 覆盖，不重复追加 |
| `data/datastore/PreferencesStore.kt` | `Settings.remoteNodes` + 独立 DataStore key（写入/读取，缺省空列表） |
| `ui/pages/setting/SettingRemoteNodePage.kt` | 设置页：填 IP/端口/token，保存即同步 |
| `RouteActivity.kt` | Screen + entry + import 三处导航 |
| `SettingPage.kt` | 设置入口（复用 `ServerStack01` 图标） |

**关键设计取舍**：
- **不新增 ProviderSetting 子类**——那要改 5 处会编译失败的 `when` + ProviderConfigure 7 处，本机无编译链不可控。
  直接复用 OpenAI Provider（`baseUrl` 指向桥的 `/llm/v1`）。
- **不侵入 ChatService 工具装配**——MCP server 加入 `settings.mcpServers` 后由原生链路处理。
- **不自动勾选 assistant**——`McpManager.kt:110` 要求 `id in assistant.mcpServers`，
  这是产品故意的安全门，用户仍需去 Assistant → MCP 勾选 `dsh_<slug>`。

**编译验证：✅ 已通过 GitHub Actions 云端编译**

用户提供了自己的仓库 `GMYSJ/rikkahub-agent-gm` 与 PAT，推送到新分支
`verify/inbuilt-20261119` 触发 CI：

| run | 结果 | 说明 |
|---|---|---|
| 44361664013 | failure | **与代码无关**：ZIP 快照缺子模块 gitlink，CMake 找不到 llama.cpp |
| 44362631085 | **success** | 补回 gitlink 后，`assembleRelease` + R8 全过（约 18 分钟） |

**master 分支完全未动**（SHA 仍是 `931345c`），全部改动只在验证分支。

过程中额外发现并修复一个工程问题：ZIP 快照的两个子模块目录是空的，
`git add -A` 忽略了空目录导致 gitlink（mode 160000）丢失；
已用 `git update-index --add --cacheinfo` 补回（提交 `7a8f27e`）。

**静态校验（此前做的，作为补充证据）**：
- 10/10 引用符号在源码中真实存在
- 三个新文件括号配对全部正确
- 导航三处、持久化三处均已核对

## Git 版本控制 ✅

2026-11-19 安装了便携版 **MinGit 2.56.1** 于 `D:\AAAdeepseek\工作区\tools\git`
（已加入用户 PATH，不进项目仓库）。

仓库已初始化，基线提交 `c4e6e87`，跟踪 1947 个文件。

```powershell
# 每次新 shell 直接用即可（已写入用户 PATH）
cd D:\AAAdeepseek\工作区\repos\rikkahub-agent-gm
git log --oneline
git status
```

## 源码模块清单（来自 settings.gradle.kts）

```
:app :ai :workspace :web :web-ui(目录) :highlight :local-llm :llama-cpp
:search :speech :common :document :material3 :videogen :oauth
```

## 待办（下一步，按优先级）

### 已完成
- [x] 安装 Git 并初始化仓库
- [x] `install_bundle` 装桥 + profile 启用 + 重启
- [x] 回环 17 项端到端验证（含双向闭环）
- [x] **局域网监听** + 17 项验证（手机现在真的能连了）
- [x] 149 个测试用例

### 下一优先（需要你在手机上操作）
- [ ] **手机 RikkaHub 接入**：
      设置 → MCP → 添加服务器 → `streamable-http`
      → `http://192.168.1.3:61420/dsh-mobile-bridge/mcp`
      → Header `Authorization: Bearer <lan.token>`
      → **务必在 Assistant → MCP 里勾选该 server**
- [ ] 实机验证后，把结果记进 `TEST_REPORT.md`

### 次优先
- [ ] 桥加 `/llm/v1/chat/completions` 门面（让 RikkaHub 能用电脑模型）
- [ ] 文件传输（分块/断点续传/完整性校验）

### 待你决定
- [ ] 是否把 `.tmp/` 调研报告纳入仓库
- [ ] 是否需要 TLS（当前局域网是明文 HTTP，仅靠 token）

## 基线事实

- 宿主：Windows 11 IoT LTSC 26200 / Ryzen 9 7945HX / 15.7GB
- DSH 版本：`0.2.2-rc.5`，安装于 `D:\AAAdeepseek\Harness`
- 活动 Profile：`desktop`
- **本机无 java / adb / gradle / git / winget / scoop / choco**
- **有 Android NDK r28**（`pd2243-work`，仅 C/C++，不能编 Kotlin）
- 构建方式：**GitHub Actions 云端构建，JDK 21**
- DSH Web 端口**每次重启变**（`--port 0`），无 portfile，只能读 `ctx.webServer.port`

## 重要：源码是 ZIP 快照，不是 Git 仓库

本机无 git，源码以 ZIP 方式获取，**没有 `.git` 目录**。
开发期间以文件级备份代替版本控制。

## 下次会话入口

```
1. 读本文件（project-docs/PROJECT_STATUS.md）
2. 读 project-docs/INDEX.md（必读顺序已更新）
3. 读 project-docs/PROTOCOL_SPEC.md（协议实现以此为准）
4. 读 project-docs/BLOCKERS.md
5. 直接开始「手机侧 Kotlin 实现」
```
