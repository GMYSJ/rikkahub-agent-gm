# 官方更新摘要 / CHANGELOG

> 每轮同步记录官方变更摘要。格式见 `SYNC_TEMPLATE.md`。
> 只记录**已核实**的官方变更，不臆测。

## 未同步区间：`2.5.1` → `3.3.1`

- 区间起点 `a9b35ba`（tag `2.5.1`）
- 区间终点 `2435dbd`（tag `3.3.1`）
- **提交数：332**，文件变更：2010（`origin/master` vs `3.3.1` 口径）
- 提交类型分布：`feat` 134 / `fix` 91 / `chore` 47 / `refactor` 25 / `docs` 12 / `perf` 8 / `build` 7 / `ci` 3 / `test` 2 / `style` 1 / 其他 2

### 按模块分布（提交数）

`chat` 44、`provider` 17、`ui` 14、`ai` 13、`settings` 11、`markdown` 9、`search` 9、`workspace` 9、`i18n` 8、`mcp` 8、`phone-use` 6、`memory` 6、`skills` 5、`mediagen` 5、`openai` 4、`model-list` 4、`assistant` 4、`sketch` 4、`imggen` 3、`media` 3、`export` 3、`backup` 3、`baselineprofile` 3、`compress` 2

### 官方 Release 摘要（节选，已核对 Release Notes）

| Tag | 日期 | 关键内容 |
|---|---|---|
| `3.3.1` | 2026-11-21 | 快速入门页；安全模式导出/导入备份；消息概览标注压缩位置；Markdown 导出含时间；商汤日日新图标；内置默认助手可删除 |
| `3.3.0` | 2026-11-16 | DeepSeek 语音合成/识别；导入 DeepSeek 聊天记录；回复按段落拆分为多气泡；工作区挂载共享存储；Vertex 服务账号支持 Interactions；**自动压缩上下文默认开启** |
| `3.2.0` | 2026-11-10 | **新增 Phone Use**；**对话过长自动压缩历史**；模型列表手动刷新；快捷消息追加输入框；修复对话地图卡顿、Claude/Mistral 多轮报错 |
| `3.1.2` | 2026-11-07 | **重写消息渲染**，改进公式；远程工作区跳板机；**工作区命令后台运行**；世界书拖拽排序；对话导出为文件；模型多关键词搜索 |
| `3.1.1` | 2026-10-24 | **新增 SSH 远程工作区**；后台生成悬浮窗；德语；**记忆整理模型设置**；工具调用显示耗时；模型能力识别更准 |
| `3.1.0` | 2026-10-19 | ChatGPT/Grok 订阅登录 + 用量查看；**用量统计页**；输入框图片预览；助手记忆「自动做梦」；语音「回复时继续聆听」；压缩可保留最近 N 条 |
| `3.0.0` | 2026-10-18 | **全新 UI 改版**（几乎所有页面）+ 新图标；**媒体创作**（图片+视频，多厂商，批量保存）；**记忆升级为文件化记忆库 + 对话结束自动归纳**；**上下文压缩改为插入总结而非删历史** + 上下文用量显示；对话级设置固定；对话列表时间排序/文件夹归属/自动标题可关 |
| `2.5.6` | 2026-10-01 | 图表工具（折线/柱状/散点）；图片生成快捷方式；提供商「高级设置」自定义请求头；Gemini Interactions API；Claude Opus 5.5/Sonnet 5.5、Gemini 4 |
| `2.5.5` | 2026-09-27 | 内置技能「技能创建助手」；技能搜索；修复技能保存崩溃 / GitHub 导入损坏；阿拉伯语 + RTL；数据恢复页 |
| `2.5.3` | 2026-09-20 | 工作区长按多选批量导出；输入栏模糊/玻璃背景；对话分支沿用标题；Step-5 模型；多项稳定性修复 |
| `2.5.2` | 2026-09-15 | 火山引擎语音朗读；工作区读取 `AGENTS.md`；DeepSeek Flash 适配；重新生成确认提示 |

### 高价值 P0 修复（已从 commit 标题核实）

| Commit | 内容 |
|---|---|
| `a8508e2` | 修复 Android 9/10 导入含 `#` 文件名附件的 DeepSeek 记录时崩溃 |
| `1575d17` | 兼容中转接口返回空 `role` 导致解析崩溃 |
| `240deb5` | 流式响应中 `null` 行/元素导致解码崩溃 |
| `72747fc` | 生成结束与新生成同时发生时前台服务未及时 `startForeground` 导致崩溃 |
| `42896e5` | MCP 列表 `LayoutNode not found in RectList` 闪退（#2179） |
| `cf79246` | MCP 工具 `inputSchema` 内联展开 `$ref`，修复 `$defs` 丢失导致请求 400（#1974） |
| `4ba5d79` | MCP 受保护资源元数据缺失时回退 origin，首次 401 触发 OAuth（#1979） |
| `85af5b9` | OpenRouter 图片编辑 404；模型名含斜杠时相册图片丢失（#1993） |
| `9f02586` | 技能文件保存失败崩溃；GitHub 导入按字节保存（二进制损坏） |
| `ed3569c` | 工作区文件编辑器不再全文存 saved state，修复大文件切后台崩溃（#1953） |
| `bf8ff5a` | proot 升级，修复 Ubuntu 26.04 下 rust-coreutils `Security violation`（#2158） |
| `e10e104` | 多步生成循环与工具审批协议拆到 `ai` 模块 `agent` 包；修复混合审批、中途停止丢失工具结果、正则重复应用 |

### 结构性重构（高迁移成本，需单独评估）

| Commit | 内容 |
|---|---|
| `fffa6e8` | 整理 `data` 包结构：拆出 `skills`、合并 `remote`、移走非数据层代码 |
| `e10e104` | 生成循环/审批协议迁移到 `ai` 模块 `agent` 包 |
| `80845dd` | 全文搜索去掉 jieba 分词，改 Kotlin 拼接查询；**arm64 APK 25.8MB → 20.8MB** |
| `815e9c2` | 用纯 Kotlin 实现 PDF 文本提取替换 mupdf，删 JNI 与 `libmupdf_java.so`；**arm64 APK 35.4MB → 30.9MB** |

---

## 本轮（2026-11-22）：仅审计，未移植

- 完成 Git 拓扑修复（见 `UPSTREAM.md` 第 2 节）
- 建立 `integration/upstream-202611` 集成分支
- 产出 5 份上游文档
- **未修改任何业务逻辑代码**
---

## 本轮（2026-11-22）验证结果

**CI run #40 — 成功**

| 项 | 值 |
|---|---|
| Run | [#40](https://github.com/GMYSJ/rikkahub-agent-gm/actions/runs/44943431686) |
| 分支 / Commit | `integration/upstream-202611` / `8b4bee0` |
| 结果 | `success` / `BUILD SUCCESSFUL in 13m 25s` |
| 产物 | `RikkaHub-run40-arm64`，50.2 MB（解压 APK 55.7 MB） |
| versionName / Code | `2.5.1-agent.4` / 190（未改版本号） |
| applicationId | `excp.rikkahub`（未改） |
| 构建任务 | `:app:assembleRelease`（arm64-v8a，R8） |

### 失败的第一次尝试（已修复，记录备查）

**CI run #39 — 失败**

- 失败步骤：`Build Release APK`
- 报错：`McpToolSchema.kt:1:1 Syntax error: Expecting a top level declaration`（连锁
  `Unresolved reference 'toSchema'` ×2）
- 根因：本机 PowerShell 5.1 的 `>` 重定向把两个新文件写成 UTF-16LE（`FF FE` BOM）
- 修复：`8b4bee0` 用原始字节重写，`McpToolSchema.kt` blob 与官方 **逐字节相同**
- 详见 `CONFLICTS.md` C-12

### ⚠️ 测试状态如实说明

| 验证项 | 状态 | 说明 |
|---|---|---|
| Release 编译（含 R8） | **通过** | run #40 |
| `McpToolSchemaTest`（6 例） | **未测试** | 现有 CI 只跑 `assembleRelease`，**不执行单元测试** |
| `ChatCompletionsStreamDecoderNullTest` | **未测试** | 同上 |
| Agent 工具调用链回归 | **未测试** | 本机无 ADB，需真机 |
| 旧数据迁移 | **不适用** | 本轮未改数据库版本与数据结构 |
| 功能行为验证 | **未测试** | 需真机安装 APK |

**结论：本轮只能声明"编译通过、产物已生成"，不能声明"功能测试通过"。**
下一步需要在 workflow 中补 `./gradlew :app:testDebugUnitTest` 或等价任务，
才能在 CI 层面验证两个新单测。
---

## 本轮（2026-11-22）第二轮：单元测试接入并转硬门禁

**CI run #41 — 成功**（[链接](https://github.com/GMYSJ/rikkahub-agent-gm/actions/runs/44945544278)）

本轮补上了一个真实存在的验证缺口：workflow 此前**只跑 `assembleRelease`，从不执行任何单测**。

### 基线实测结果（来源：artifact `unit-test-reports-run41` 的 HTML 报告）

| 模块 | tests | failures | skipped | 测试类 | duration |
|---|---|---|---|---|---|
| `ai`  | **307**  | **0** | 0 | 37  | 2.479s |
| `app` | **1723** | **0** | 0 | 217 | 12.197s |
| **合计** | **2030** | **0** | 0 | 254 | — |

本轮移植的两个测试**确认已执行并通过**：

| 测试 | 所在模块 | 证据 |
|---|---|---|
| `McpToolSchemaTest` | `app` | 出现在 app 报告索引的 217 个类中 |
| `ChatCompletionsStreamDecoderNullTest` | `ai` | 出现在 ai 报告索引的 37 个类中 |

### 策略变化

1. 首轮用 `continue-on-error: true` 取基线（测试从未跑过，怕阻断产出）。
2. 基线确认 **0 失败**后，**已移除该开关，改为硬门禁** ——
   今后测试失败即中断，不再产出 APK。

### 数据口径更正

此前 `AUDIT_REPORT.md` / 首轮 CHANGELOG 按 `git ls-tree` 统计为
「277 个测试文件」，与实际的 **2030 个测试方法**不是同一口径。
以报告数字为准，**测试文件数 ≠ 测试数**。
---

## 本轮（2026-11-22）第三轮：验收与覆盖安装策略修正

### run #43 — 成功（[链接](https://github.com/GMYSJ/rikkahub-agent-gm/actions/runs/44949152788)）

commit `6f88907`，20 步全 success，产物 `RikkaHub-run43-arm64` 50.17 MB。

| 模块 | tests | failures |
|---|---|---|
| `ai`  | 308  | 0 |
| `app` | 1723 | 0 |
| **合计** | **2031** | **0** |

新增的 `ModelRegistryTest.testMagnitudeNotVersion` 确认执行（ai 308，比 #41 多 1 例）。
三个关键测试均在报告索引中：`ModelRegistryTest` / `McpToolSchemaTest` /
`ChatCompletionsStreamDecoderNullTest`。

### run #44 — 成功（[链接](https://github.com/GMYSJ/rikkahub-agent-gm/actions/runs/44951448987)）

commit `738ad14`，23 步全 success。

关键验收点（新增守卫）：

`
Verify versionCode stays fixed (bidirectional overwrite-install) -> success
versionCode=190 versionName=2.5.1-agent.4 (expected 190)
applicationId=excp.rikkahub.agent
release.keystore present (fixed signing key)
`

产物与构建摘要：

`
APK=RikkaHub-2.5.1-agent.4-arm64-v8a.apk
SIZE=55701989
SHA256=ab1f8d183b24df66e97ba9490189ff39df6b4e68a6fcbd561905e4e549a2f2ba
BUILD SUCCESSFUL in 17m 30s
`

测试同样 2031 例全过。

### 覆盖安装策略修正（重要，曾写错）

**上一轮的错误**：把 versionCode 设成 `run_number + 190` 自动递增。

**为什么错**：递增只保证"新能覆盖旧"，却让"旧无法覆盖新"：

`
装 #38(190) -> 装 #43(233) 成功
#43 出 bug  -> 装回 #38(190) 被拒（190 < 233）-> 必须卸载 -> 工作区数据丢失
`

工作区数据有数 GB，这正是用户明确要求避免的场景。

**修正为固定 190**：

| 版本关系 | 覆盖安装 |
|---|---|
| 更大 | ✅ |
| **相等** | ✅ **（双向，可回退）** |
| 更小 | ❌ |

任意两个历史包 versionCode 相同 => 任意方向互相覆盖都合法。
版本区分改用 SHA-256 + artifact 名 + commit SHA（均写入 Step Summary）。

**已核实的三项固定值**：

| 项 | #38（用户当前安装） | #43 / #44 | 结论 |
|---|---|---|---|
| applicationId（release） | `excp.rikkahub.agent` | 同 | 一致 |
| `release.keystore` blob | `7629852...` | 同 | 同一把钥匙 |
| versionCode | `190` | 同 | 双向可覆盖 |

守卫已加入 workflow：versionCode 被改动或 keystore 丢失时构建直接失败，
不会产出无法覆盖的包。详见 `OVERWRITE_INSTALL.md`。
---

## 本轮（2026-11-22）第四轮：3 项稳定性修复

### run #45 — 成功（[链接](https://github.com/GMYSJ/rikkahub-agent-gm/actions/runs/44954042959)）

commit `0a1d13f`，23 步全 success，无异常步骤。

| 项 | 值 |
|---|---|
| 产物 | `RikkaHub-run45-arm64`，50.17 MB |
| versionCode 守卫 | **success**（仍为 190，双向覆盖能力保持） |
| 测试 | ai 308 + app 1723 = **2031，0 失败** |

### 本轮移植（全部 +4 行以内的精确改动）

| 官方 Commit | 内容 | 影响 |
|---|---|---|
| `923ad3d91` | 协程取消异常被 `catch(IllegalStateException)` 吞掉 | **取消对话后事务内无限循环** → 已修 |
| `8b696c0cf` | MCP 空名称请求头 | OkHttp 抛 `name is empty`，MCP 连接失败 → 已修 |
| `2d5c51bd5` | 复制超大请求体 | `TransactionTooLargeException` 闪退 → 已修（改为 Toast 提示） |

### 本轮评估后跳过（均有依据，非遗漏）

| 官方 Commit | 跳过理由 |
|---|---|
| `4391d5a5e` | 主体无该 schema 字段白名单机制 |
| `4e4bfa62b` | 主体用 `aspectRatio` 枚举，无 `params.size` 字段 |
| `a8508e232` | 目标文件在主体中不存在（官方 3.x 新功能） |
| `50bbc99bb` / `dfbe9a082` | 主体无 `bettertext` 依赖 |

### 移植池量化（长期依据）

官方 1352 个改动文件中，**681 个在主体存在**（可移植），**671 个不存在**（3.x 新增）。
其中「单文件 + 纯 fix + 文件存在」的 **30 个**是最安全移植池，本轮取 3 个。
