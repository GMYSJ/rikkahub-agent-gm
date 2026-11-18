# 项目状态 / PROJECT STATUS

> 每次会话开始先读本文件与 `BLOCKERS.md`，不要重复已完成工作。
> 每次阶段完成必须更新本文件。

## 当前阶段

**阶段 0 完成 · 阶段 1 完成 · 阶段 3 DSH 侧已装机并实测通过**

> **2026-11-19 重大进展**：桥已装进 desktop profile 并启用，
> 在真实 DSH 上完成 17 项端到端验证（含双向闭环），全部通过。
> 详见 `TEST_REPORT.md` 第四轮。

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
重启后端口 `61412`，在**真实 DSH** 上验证 17 项全绿：

- `/tools` 从真实 `ctx.tools` 读到 **18 个工具**
- MCP 握手 → `tools/list` → `tools/call` 全链路通
- `memory_list` 真实执行并返回记忆库数据
- **双向闭环**：DSH → 桥 → 远端节点 → 回传 `{"battery":87}` ✅
- 安全防护（401/403/508/防自我回显）在真实环境全部生效
- 原有 15 个 bundles 一个不少，`im-qqbot` 凭据未动

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

### 已完成（本轮）
- [x] 安装 Git 并初始化仓库（基线提交 `c4e6e87`）
- [x] `install_bundle` 装桥 + profile 启用 + 重启
- [x] 真实 DSH 上 17 项端到端验证（含双向闭环）

### 下一优先
- [ ] **真机验证**：手机 RikkaHub → MCP → `streamable-http` →
      填 `https://<电脑局域网IP>:<端口>/dsh-mobile-bridge/mcp` + Bearer token
      —— 需要你操作（本机无 adb）
- [ ] 让桥监听局域网地址（当前 DSH webServer 只绑 `127.0.0.1`，
      手机要访问必须经移动网关反代，或用 `dsh-go-workspace` 的 3443 通道）
- [ ] 桥加 `/llm/v1/chat/completions` 门面
- [ ] 文件传输（分块/断点续传/完整性校验）
- [ ] CI 加测试步骤

### 待用户决定
- [ ] 是否把 `.tmp/` 下两份调研报告纳入仓库（目前未跟踪）
- [ ] 是否给桥配局域网可达的入口（涉及移动网关配置，需谨慎）

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
