# 迁移记录 / MIGRATION LOG

> 每个移植条目必须记录：日期、官方 Commit、主体 Commit、修改文件、迁移方式、冲突处理、测试结果、回滚提交。

## 索引

| # | 日期 | 功能 | 官方 Commit | 主体 Commit | 风险 |
|---|---|---|---|---|---|
| 0 | 2026-11-22 | 真实 Git 历史恢复 + 成果重接 | — | `d384a11` `4a77cdb` | 已完成 |
| 1 | 2026-11-22 | MCP `$ref` 内联展开 | `cf79246b` | `be70c1b` | 低 |
| 2 | 2026-11-22 | OpenAI 空 role 兼容 | `1575d179` | `bd290b2` | 低 |
| 3 | 2026-11-22 | 流式 null 行/元素容错 | `240deb5f` | `3ff850b` | 低 |
| 4 | 2026-11-22 | MCP OAuth 元数据缺失回退 | `4ba5d79f` | `773285a` | 低 |

---

## #0 真实 Git 历史恢复（基础工程）

**问题**：工作区检出的 `verify/inbuilt-20261119` 是从 ZIP 快照 `git init` 的空历史分支，
与官方无共同祖先，无法同步。

**处理**：
1. `git remote add origin` → fetch，得到真实历史 `origin/master`（`931345c`）。
2. 验证 `merge-base origin/master official/master` = `2689e75`（成立）。
3. `git checkout -b integration/upstream-202611 origin/master`。
4. 从快照分支取回成果：
   - `git checkout verify/inbuilt-20261119 -- win-bridge project-docs`
   - 远程节点功能 5 文件 + 4 个集成触点
5. 拆成 2 个提交：`d384a11`（远程节点）、`4a77cdb`（桥 + 文档）。

**验证**：`git diff --stat verify/inbuilt-20261119 HEAD -- app` → 0 处差异，无丢失。

**回滚**：`git checkout verify/inbuilt-20261119`（旧分支保留）。

---

## #1 MCP `$ref` 内联展开

- **日期**：2026-11-22
- **官方**：`cf79246bf`（2026-10-01，#1974）
- **主体提交**：`be70c1b`
- **功能**：`toSchema()` 只搬运 `properties`/`required`，`$defs` 被丢弃而 `$ref` 原样发出，
  provider 校验到悬空引用后拒绝整个请求（Gemini 等）。

- **修改文件**：
  | 文件 | 操作 |
  |---|---|
  | `app/.../data/ai/mcp/McpToolSchema.kt` | 新增（89 行，官方逐字） |
  | `app/src/test/java/.../McpToolSchemaTest.kt` | 新增（官方单测） |
  | `app/.../data/ai/mcp/McpSessionRegistry.kt` | 删除私有 `toSchema` + 2 个不再用的 import（−5 行） |

- **迁移方式**：**逐字移植**。

- **关键兼容性核实**（本项最大风险）：
  官方此项改动写于 `mcp = "0.15.0-rikka.2"`（官方自维护 fork：
  `com.github.rikkahub.mcp-kotlin-sdk`），而主体用上游
  `io.modelcontextprotocol:kotlin-sdk-client:0.15.0`。
  经核对上游 `kotlin-sdk` tag `0.15.0` 的
  `kotlin-sdk-core/.../types/tools.kt`，`ToolSchema` 已含：
  ```kotlin
  @SerialName("\$defs") val defs: JsonObject? = null,
  val type: String = "object"
  ```
  与官方当时所用版本这两项定义**完全一致**，因此**无需切换 SDK 源**即可编译。

- **冲突处理**：无。主体该文件当时只有一处 `toSchema`，与官方删除的 5 行一一对应。

- **测试**：官方 `McpToolSchemaTest`（6 个用例）已纳入；结果见 CI。

- **回滚**：`git revert be70c1b`

---

## #2 OpenAI 空 role 兼容

- **日期**：2026-11-22
- **官方**：`1575d179d`（2026-10-28，Fixes #2266）
- **主体提交**：`bd290b2`
- **功能**：部分中转返回空字符串或非标准 `role`，`MessageRole.valueOf` 抛
  `IllegalArgumentException`，整轮生成中断。

- **修改文件**：
  | 文件 | 操作 |
  |---|---|
  | `ai/.../core/MessageRole.kt` | 新增 `companion.fromValueOrNull`（+6） |
  | `ai/.../openai/ChatCompletionsAPI.kt` | `valueOf` → `fromValueOrNull ?: ASSISTANT` |
  | `ai/.../openai/ChatCompletionsStreamDecoder.kt` | 同上 |
  | `.gitignore` | 追加 `/debug.log`（第三方输入法误写） |

- **迁移方式**：逐字移植 + 调用点适配（主体原先用 `.uppercase()` 再 `valueOf`，
  官方新写法本身 `ignoreCase = true`，故去掉 `uppercase()`）。

- **测试**：无官方单测；改动为纯防御性回退，语义等价于原「未知回退 ASSISTANT」。

- **回滚**：`git revert bd290b2`

---

## #3 流式 null 行/元素容错

- **日期**：2026-11-22
- **官方**：`240deb5fe`（2026-10-15，#2137）
- **主体提交**：`3ff850b`
- **功能**：中转在流中返回 `data: null`，或在 `reasoning_details`/`annotations`
  中夹杂 `null`，强制按对象解析抛 `JsonNull is not a JsonObject`，中断整轮生成。

- **修改文件**：
  | 文件 | 操作 |
  |---|---|
  | `ai/.../openai/ChatCompletionsStreamDecoder.kt` | 3 处 `jsonObject` → `jsonObjectOrNull`；`map` → `mapNotNull`；删 1 个 import |
  | `ai/src/test/java/.../ChatCompletionsStreamDecoderNullTest.kt` | 新增（官方单测） |

- **迁移方式**：逐字移植。

- **依赖核实**：`jsonObjectOrNull` 来自 `me.rerere.common.http.jsonObjectOrNull`，
  主体 `common/.../http/Json.kt` 已定义，且该文件原本已 import，无需新增依赖。

- **测试**：官方单测覆盖 `data: null` 行、`reasoning_details:[null]`、
  `annotations:[null,{...url_citation:null}]` 三种情况。

- **回滚**：`git revert 3ff850b`

---

## #4 MCP OAuth 元数据缺失回退

- **日期**：2026-11-22
- **官方**：`4ba5d79f2`（2026-10-01，#1979）
- **主体提交**：`773285a`
- **功能**：
  1. `authorize()` 强依赖 RFC 9728 元数据；不提供该元数据的服务器（如 Zomato）
     无法完成授权。改为 discovery 失败时退回 `serverOrigin(serverUrl)`。
  2. `needsAuthorization()` 原先要求 `oauth.enabled == true` 才在 401 时触发授权，
     导致未显式开启 OAuth 的服务器首次 401 不进入授权流程。

- **修改文件**：
  | 文件 | 操作 |
  |---|---|
  | `app/.../mcp/McpOAuthCoordinator.kt` | 2 处逻辑修正（+10/−5） |
  | `app/.../mcp/McpOAuthDiscoveryClient.kt` | 新增 `serverOrigin()`（+8） |

- **迁移方式**：逐字移植（+17/−5，与官方一致）。

- **依赖核实**：`toHttpUrlOrNull` / `HttpUrl` 在该文件已 import。

- **测试**：无官方单测；改动为降级回退，原有成功路径不变。

- **回滚**：`git revert 773285a`

---

## 待办（下一轮）

| 功能 | 官方 Commit | 风险 | 说明 |
|---|---|---|---|
| 技能保存崩溃 + 二进制导入损坏 | `9f02586d3` | 低 | `SkillManager.kt` / `SkillsVM.kt` |
| 大文件切后台崩溃 | `ed3569c70` | 低 | 工作区编辑器 saved state（#1953） |
| 生成结束与新生成竞态崩溃 | `72747fc9e` | 低 | 前台服务 `startForeground` |
| DeepSeek 导入附件崩溃 | `a8508e232` | 中 | Android 9/10 文件名含 `#` |
| MCP 列表闪退 | `42896e5ad` | 中 | Compose 测量期崩溃（#2179） |
| **Phone Use 架构对照** | `3.2.0` | **极高** | 需先设计统一调度层 |
| **Tool Calling 协议重构** | `e10e10433` | **极高** | 需真实调用链验证 |
| Memory 文件化迁移 | `3.0.0` | 高 | 需先备份 + 幂等迁移设计 |
| 上下文压缩改插入总结 | `3.0.0` | 高 | 需先定状态保留策略 |
| UI 全改版 | `3.0.0` | 高 | 最后做 |
---

## #5 技能保存崩溃 + 二进制导入损坏

- **日期**：2026-11-22
- **官方**：`9f02586d3`
- **主体提交**：`7836cdb`
- **功能**：`saveSkillFile` 直接 `writeText`，IO 异常抛到 UI 层导致保存技能闪退；
  GitHub/ZIP 导入走 `downloadText` 会把图片等二进制附件当 UTF-8 解码而损坏。
- **修改文件**：`SkillManager.kt`（临时文件 + rename，异常返回 false，删死重载）、
  `SkillsVM.kt`（`downloadText` → `downloadBytes`，两处保存改 `saveSkillFileBytesAtomically`，
  ZIP 目录导入 `readText` → `readBytes`，GitHub API 限流明确提示）
- **迁移方式**：逐字移植 + 1 处同意图补强（本地目录导入路径也改字节）
- **测试**：无官方单测；结果为 IO 异常不再外抛
- **回滚**：`git revert 7836cdb`

---

## #6 工作区文件编辑器大文件崩溃

- **日期**：2026-11-22
- **官方**：`ed3569c70`（#1953）
- **主体提交**：`b8a6edda`
- **功能**：`rememberTextFieldState` 把编辑框全文写进 saved state Bundle，
  打开大文件后切后台触发 `TransactionTooLargeException`。
- **修改文件**：`WorkspaceFileEditorPage.kt`（`rememberTextFieldState` → `remember { TextFieldState() }`）、
  `SkillDetailPage.kt`（`rememberSaveable` → `remember`）
- **规模**：+5/−3，与官方一致
- **回滚**：`git revert b8a6edda`

---

## #7 修正 #1 的文件编码（CI 失败复盘）

- **日期**：2026-11-22
- **主体提交**：`8b4bee0`
- **问题**：CI run #39 失败，Kotlin 在 `McpToolSchema.kt:1:1` 报
  `Expecting a top level declaration`，并连锁导致 `McpSessionRegistry.kt` 两处
  `Unresolved reference 'toSchema'`。
- **根因**：本机 PowerShell 5.1 的 `>` 重定向默认写 UTF-16LE。
  用 `git show ... > file` 落盘的两个新文件带 `FF FE` BOM，
  每个字符前插 `\0`，Kotlin 解析器看到的就是乱码。
- **修复**：改用 .NET 进程直接读取 git 的 `StandardOutput.BaseStream` 取得原始字节，
  `[System.IO.File]::WriteAllBytes` 落盘。修复后：
  - `McpToolSchema.kt` blob = `4121c72`，与官方 `cf79246bf` 的 blob **逐字节相同**
  - `McpToolSchemaTest.kt` blob 亦与官方一致
- **全仓验证**：扫描所有 `*.kt/*.kts/*.md/*.yml/*.json/*.toml/*.gradle`，无其它 UTF-16 BOM。
- **约束（写入 CONFLICTS.md）**：本机 PowerShell 5.1 写源码必须用
  `[System.IO.File]::WriteAllBytes` 或 `WriteAllText(path, text, UTF8Encoding(false))`；
  **禁止**用 `>` / `Out-File` / `Set-Content` 写任何源文件。
---

## #8 前台服务竞态修复 —— 不适用（已论证）

- **日期**：2026-11-22
- **官方**：`72747fc9e`
- **结论**：**不移植**（主体已用不同机制解决同一问题）

**官方做法**：`acquire`/`release` 改签名接收 `startId`，把裸 `stopService()` 换成
`stopSelf(startId)`，避免在排队的 `startForegroundService()` 还没 `startForeground()`
时把服务停掉（否则 `ForegroundServiceDidNotStartInTimeException`）。

**主体现状**（`ChatGenerationForegroundService.kt` 实测）：
- 架构已重构为**共享期望状态**：`private val shouldRun = AtomicBoolean(false)`
- `onStartCommand` 首先检查 `if (!shouldRun.get())`，用 `stopSelfResult(startId)` 收尾
- 全文件**没有任何**裸 `stopService()`
- 也不存在 `ACTION_ACQUIRE` / `ACTION_RELEASE` 这对 action

**判定依据**：官方修复针对的是「无条件 `stopService()` 与排队 ACQUIRE 竞态」，
主体已用原子标志把过期的 stop 降级为 no-op，注释原文即
"It avoids stopService() racing a new start and killing its service instance"。
硬套官方补丁会与主体架构冲突，收益为零。

**回滚**：无需（未改动）

---

## #9 单元测试接入 CI（验证基础设施）

- **日期**：2026-11-22
- **主体提交**：`a835ba2`（接入）+ 后续（转硬门禁）
- **问题**：workflow 只跑 `:app:assembleRelease`，仓库里的单测
  **从未在 CI 执行**，包括本轮移植引入的 `McpToolSchemaTest` 与
  `ChatCompletionsStreamDecoderNullTest`。等于没有回归网。
- **改动**：`build-android.yml` 新增
  `:ai:testDebugUnitTest :app:testDebugUnitTest --continue --stacktrace`
  + 上传 `unit-test-reports-run<N>` artifact。
- **首轮策略**：`continue-on-error: true` 取基线。
- **基线结果（run #41，实测自 HTML 报告，非日志推断）**：

  | 模块 | tests | failures | skipped | 测试类数 | duration |
  |---|---|---|---|---|---|
  | i  | **307**  | **0** | 0 | 37  | 2.479s |
  | pp | **1723** | **0** | 0 | 217 | 12.197s |
  | 合计  | **2030** | **0** | 0 | 254 | — |

  两个移植测试**确认执行并通过**：
  - `ChatCompletionsStreamDecoderNullTest` → 出现在 `ai` 报告索引
  - `McpToolSchemaTest` → 出现在 `app` 报告索引

- **结论**：基线全绿，已把 `continue-on-error` 移除，改为**硬门禁**
  （测试失败即中断，不再产出 APK）。
- **更正**：此前按 `git ls-tree` 文件数估算为「277 个测试文件」，
  与实际执行的 **2030 个测试**不是同一口径（一个文件含多个测试方法）。
  以报告数字为准。
- **回滚**：`git revert a835ba2`（连同门禁改动）

---

## Phone Use 架构对照（阶段 E 前置，本轮不移植）

- **产出**：`PHONE_USE_ARCHITECTURE.md`
- **结论摘要**：
  - 官方 `PhoneUseAccessibilityService`（`app/src/github/`）与主体
    `RikkaAccessibilityService`（`app/src/main/`）是**两个独立无障碍服务**，
    同时启用会抢屏幕，且用户需授权两次。
  - 能力高度对称（截图 / 节点树 / 点击 / 滑动 / 输入 / 按键 / 应用启动 / 操作状态）。
  - 决定：**保留主体服务为唯一底层**，Phone Use 只作工具层 + 适配层。
  - 两边都**没有**单串行操作队列，需补。
- **未执行原因**：本机无 ADB，无法验证「不抢屏幕」这一核心验收点。
---

## #10 协程取消异常被吞 → 事务内无限循环

- **日期**：2026-11-22
- **官方**：`923ad3d91`（Fixes #2151）
- **主体提交**：`0a1d13f`
- **功能**：`ConversationRepository.loadMessageNodes` 在 `withTransaction` 内
  用 `catch (IllegalStateException)` 丢弃"读不出的节点"并 `continue`。
  但 `CancellationException` 是 `IllegalStateException` 的子类 ——
  用户取消后取消异常被吞，循环继续，**在事务内无限空转**。
- **修改**：`ConversationRepository.kt` +4 行（新增 `catch (CancellationException) { throw e }`，
  置于 `IllegalStateException` 之前）
- **迁移方式**：逐字移植（+4，与官方一致）
- **回滚**：`git revert 0a1d13f`

---

## #11 MCP 空名称请求头导致连接失败

- **日期**：2026-11-22
- **官方**：`8b696c0cf`（#1949）
- **功能**：设置页「添加请求头」后未填写名称会留下空字符串头，
  OkHttp 直接抛 `name is empty`，整个 MCP 连接失败。
- **修改**：`McpSessionRegistry.kt` 的 `resolvedHeaders()` 过滤 `it.first.isNotBlank()`
- **回滚**：`git revert 0a1d13f`

---

## #12 复制超大请求体导致剪贴板闪退

- **日期**：2026-11-22
- **官方**：`2d5c51bd5`（#1980）
- **功能**：请求体过大时 Binder 抛 `TransactionTooLargeException`
  （被包装为 `RuntimeException`），原 `setClipEntry` 未捕获 → 闪退。
- **修改**：`LogPage.kt` 捕获 `RuntimeException` 并 Toast 提示；
  新增 `LocalContext` / `Toast` 导入与 `val context`
- **回滚**：`git revert 0a1d13f`

---

## 本轮评估后跳过的官方修复（有依据）

| 官方 Commit | 内容 | 跳过理由 |
|---|---|---|
| `4391d5a5e` | Google 过滤工具参数 `propertyNames` | 主体 `GoogleProvider` **没有**这套 schema 字段白名单机制（`propertyNames`/`additionalProperties` 在主体中完全不存在），该修复无落点 |
| `4e4bfa62b` | OpenAI 图片生成自定义分辨率被丢弃（#1978） | 主体图片尺寸走 `params.aspectRatio` 枚举映射（SQUARE/LANDSCAPE/PORTRAIT），**不存在** `params.size` 字符串字段，官方逻辑无可套用处 |
| `a8508e232` | DeepSeek 导入 `#` 文件名崩溃 | `DeepSeekImporter.kt` / `RemoteFileStore.kt` 在主体中**不存在**（官方 3.x 新功能 `f93764e6a` / `fffa6e82e` 才引入） |
| `72747fc9e` | 前台服务 `startForeground` 竞态 | 主体已用 `AtomicBoolean shouldRun` + `stopSelfResult` 解决同一问题，架构不同（详见 #8） |
| `50bbc99bb` / `dfbe9a082` | markdown 公式/删除线渲染 | 主体用 `com.github.rikkahub:markdown`，无官方所用的 `bettertext` 依赖 |

---

## 移植取舍的量化依据（长期参考）

官方自 `2.5.1` 以来改动 **1352 个文件**，其中：

| 分类 | 数量 | 能否直接移植 |
|---|---|---|
| 主体中**存在** | **681** | 可评估移植 |
| 主体中**不存在**（3.x 新增） | **671** | 无落点，需先有新功能载体 |

在 681 个可移植文件中，**单文件纯 fix 且文件全部存在**的有 **30 个** ——
这是最安全的移植池，本轮从中取 3 个。

> 结论：后续每轮优先在「单文件/少文件 + 纯 fix + 文件存在」池中挑选，
> 大改造（Phone Use、流式解码器重构、UI 改版）留到有真机回归能力后再做。
