# 架构冲突与适配决定 / CONFLICTS

> 长期存在的结构性冲突，以及**已经做出的**适配决定。
> 这不是待办清单，是约束：后续每轮同步都要遵守这里写下的结论。

---

## C-01 快照分支与真实历史的分裂（已解决，必须记住）

**现象**：工作区曾检出 `verify/inbuilt-20261119` —— 从 ZIP 快照重新 `git init` 的 51 提交空历史分支。
在其上 `git merge official/master` 会得到完全无关的历史，`--allow-unrelated-histories` 会产生数千假冲突。

**根因**：早期本机无 git，源码以 ZIP 快照方式获取，后来补齐 git 时重新提交，丢失了与官方 fork 的祖先关系。

**解决**（2026-11-22）：
1. 加入 `origin`（`GMYSJ/rikkahub-agent-gm`）并 fetch，得到真实历史 `origin/master`。
2. 验证 `git merge-base origin/master official/master` → `2689e75`（非空，成立）。
3. 从 `origin/master` 拉 `integration/upstream-202611`。
4. 从快照分支 `checkout -- win-bridge project-docs` 与远程节点功能源码、4 个集成触点。
5. 拆成 2 个语义化提交（`d384a11` 远程节点、`4a77cdb` 桥+文档）。
6. 验证 `git diff --stat verify/inbuilt-20261119 HEAD -- app` → **0 处差异**，无工作丢失。

**约束**：
- 后续开发**只在有共同祖先的分支上做**。
- 开工先跑 `git merge-base HEAD official/master`，必须返回 SHA。
- `verify/inbuilt-20261119` 只作历史证据保留，不再在其上开发。

---

## C-02 不做整体 merge，只做模块级移植

**决定**：`official/master` 与主体间有 282 个双方都改过的文件，且官方 3.0.0 是大版本重构。
整体 `git merge` 会产出无法审查的巨型冲突。

**策略**：
- 按模块/功能拆分成独立提交。
- 每个移植条目必须记录官方 Commit、文件路径、改动范围。
- 高风险项先隔离、记录，继续其他独立任务，不阻塞整体。

---

## C-03 Phone Use 与 GMYSJ Device Tools 的执行冲突（未解决，最高优先级）

**冲突本质**：官方 3.2.0 新增 Phone Use；GMYSJ 已有 91 个设备工具文件、4 个无障碍相关文件。
两套执行器同时控制屏幕 = 未知状态 + 争抢无障碍服务。

**官方侧**：`app/src/main/java/me/rerere/rikkahub/data/ai/tools/local/PhoneUseTool.kt`
**主体侧**：`app/.../data/ai/tools/local/`（91 文件）+ `AccessibilityServiceHandle.kt`

**已定约束**：
- **不要**简单注册两套同名工具。
- **不要**让两个自动化执行器同时控制屏幕。
- 必须先设计统一调度层，底层尽可能复用**经过验证的 GMYSJ 执行器**。
- 在调度层落地前，Phone Use 不进稳定分支。

**待办**：补齐两边权限来源、操作队列、取消/超时/失败恢复、服务生命周期的对照表。

---

## C-04 Tool Calling 协议被官方重构

**官方改动**：`e10e104` 把多步生成循环与工具审批协议拆到 `ai` 模块 `agent` 包，
同时修复：混合审批、中途停止丢失工具结果、正则重复应用。

**主体风险**：GMYSJ 有 91 个工具 + Sub-Agent 调度 + Telegram 远程审批，调用链比官方复杂得多。

**已定约束**：
- 必须用**真实调用链**验证，不能只验证模型能输出工具 JSON：
  `模型响应 → Tool Call 解析 → 权限判断 → 审批 → 执行 → 结果回传 → 下一轮模型请求`
- 特别注意不同 Provider 对并行工具、空参数、部分流式参数、工具调用 ID、结果角色的差异。
- **不得绕过审批**。GMYSJ 的 `HardlineCommandGuard` 与工具审批是红线。

---

## C-05 上下文压缩不能吞掉 Agent 长任务状态

**官方改动**：3.0.0 把压缩从「删除历史」改为「插入总结」；3.2.0 自动压缩；3.3.0 默认开启。

**冲突**：GMYSJ 有后台任务、子 Agent、Workflow、SSH 会话、待审批操作，这些状态不能因为压缩而丢失。

**已定约束**：
- 必须区分：用户/助手对话、工具调用记录、工具结果、后台任务 ID、子 Agent 状态、
  Workflow 状态、SSH 会话状态、文件路径上下文、待审批操作、未完成任务。
- 必要时把执行状态持久化到**独立数据结构**，不要只依赖聊天消息文本。
- 压缩前后都要测试：任务能否继续、取消、查询。
- 不能把「聊天记录压缩成功」当成「Agent 长任务上下文安全」。

---

## C-06 Memory 数据结构不兼容

**官方**：3.0.0 改为按文件整理的记忆库 + 对话结束自动归纳；3.1.1 加记忆整理模型设置。

**已定约束**：
- 先备份旧记忆，再识别数据格式与版本。
- 迁移必须**幂等**，保留原始数据或可恢复副本。
- 禁止直接清空旧记忆后启用新系统。
- 必须验证多 Assistant 的记忆隔离、导入导出、备份恢复。

---

## C-07 Workspace 语义差异

**官方**：SSH 远程工作区（3.1.1）、跳板机与后台命令（3.1.2）、挂载共享存储（3.3.0）。
**主体**：`workspace` 模块 26 文件，已有自己的目录、任务 ID、会话语义。

**已定约束**：
- 必须兼容原有工作区目录、任务 ID、会话与用户数据。
- 官方 WorkManager 调度不能直接替换主体调度系统；先核对持久化、重试、唯一任务、取消、重启恢复语义。

---

## C-08 UI 全改版排在最后

**官方**：3.0.0 几乎重写所有页面（聊天/设置/助手/服务商/扩展/备份/翻译），并新增 `ui` 模块。

**已定约束**：
- UI 融合在基础能力稳定后做（阶段 G）。
- 必须保留 GMYSJ 独有入口：Agent 控制台、工具管理、Workflow、Schedule、Shizuku、Telegram、Doctor。
- 不能只复制 Composable 文件，要连同 StateFlow / ViewModel / DI / 导航参数 / 生命周期一起审。
- 官方新页面不能绕过 Agent 的安全设置。

---

## C-09 依赖不能照搬

**官方特有且危险**：
- `sqlite-android = "-SNAPSHOT"` + `mavenLocal()` → 依赖本地发布的快照产物，CI 上不可复现。
- `mcp = "0.15.0-rikka.4"` → 官方自维护分支。
- `quickjs` 从 `3.2.3` 降到 `1.0.15` → 版本号体系不同，不能按字面理解。
- `firebase` / `crashlytics` → 需要 `google-services.json`（主体 `.gitignore` 已排除）。
- `objectbox` → 需要 `pluginManagement.resolutionStrategy` 特殊处理。

**约束**：按最小必要范围升级，先确定兼容矩阵，不为了升一个依赖顺手升整套构建链。
不要为了追上官方版本而牺牲 GMYSJ 已有能力。

---

## C-10 签名与凭据

**现状**：`release.keystore` **被 git 跟踪**（`origin/master` 与主体均如此，官方没有）。

**已定约束**：
- 不读取、不打印、不输出私钥内容。
- 不复制到官方参考副本，不上传 Actions Artifact。
- 不擅自替换发布签名密钥 —— 换签会导致旧版本无法覆盖安装、数据迁移困难。
- 后续应迁移到 Actions Secrets / 安全文件注入，但**不在本轮擅自改写历史**。

---

## C-11 构建环境

**事实**：本机无 java / gradle / adb，只有便携 git。
**约束**：构建一律走 GitHub Actions（JDK 21，`.github/workflows/build-android.yml`）。
不得要求用户安装 Android Studio；不得用来源不明的预编译 APK 替代源码构建。
---

## C-12 本机 PowerShell 5.1 写源码的编码陷阱（已踩，必避）

**现象**：CI 报 `McpToolSchema.kt:1:1 Syntax error: Expecting a top level declaration`，
且连带出现 `Unresolved reference` 假报错。

**根因**：本机是 **Windows PowerShell 5.1**（非 Core），
`>`、`Out-File`、`Set-Content` 默认写 **UTF-16LE**（带 `FF FE` BOM）。
用 `git show <rev>:<path> > file` 落盘源码，文件里每个字符前会插 `\0`，
Kotlin 解析器看到的就是乱码。

**正确做法**：
`powershell
# 方法 A：从 git 取原始字节（推荐，保证与上游 blob 逐字节一致）
 = New-Object System.Diagnostics.ProcessStartInfo
.FileName = "<git.exe path>"
.Arguments = "-C "<repo>" show <rev>:<relPath>"
.RedirectStandardOutput = True; .UseShellExecute = False; .CreateNoWindow = True
 = [System.Diagnostics.Process]::Start()
 = New-Object System.IO.MemoryStream
.StandardOutput.BaseStream.CopyTo(); .WaitForExit()
[System.IO.File]::WriteAllBytes(, .ToArray())

# 方法 B：自己构造文本时
[System.IO.File]::WriteAllText(, , [System.Text.UTF8Encoding]::new(False))
`

**禁止**：用 `>` / `Out-File` / `Set-Content` 写任何 `.kt/.kts/.md/.yml/.gradle` 源文件。
`Out-File -Encoding utf8NoBOM` 在本机 5.1 **不存在**（那是 pwsh 7 的参数）。

**校验**：提交前跑一次 UTF-16 BOM 扫描（见 migration-log #7）。
修复后 `McpToolSchema.kt` 的 blob 是 `4121c72`，与官方 blob 完全一致 —— 这是最硬的验证。
