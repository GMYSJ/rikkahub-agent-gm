# 第一阶段：官方 UI / 聊天体验迁移 — 快速入门页

> 状态：**已迁移，A 级验收通过（CI #49）**
> 迁移日期：2026-11-22
> 功能分支：`feature/upstream-quickstart`
> 官方来源：`rikkahub/rikkahub` master @ `2435dbdf4`

---

## 1. 本次实际迁移的官方功能

**快速入门页（QuickStart）** — 官方 3.3.1 新增功能。

用户安装后能实际看到/使用的变化：

| 入口 | 位置 | 行为 |
|---|---|---|
| 🚀 火箭图标 | 设置页右上角 | 点击进入快速入门页 |
| 快速入门页 | 新页面 | 分步引导：配置服务商 → 选择模型 → 搜索 → TTS → 开始聊天 |
| 模型快捷设置 | 页内 | 点选模型后设为默认聊天模型；若快速模型/翻译模型未配置，一并设上 |

页面内容来自官方 3.3.1 的 `QuickStartPage` / `QuickStartGeneralTab` / `QuickStartComponents`。

**简化说明**：官方原版有两个标签（通用配置 / 从 DeepSeek 迁移）。
DeepSeek 迁移依赖官方 3.x 对 `Conversation` 新增的 `config` 字段
（`ConversationConfig` / `DeepSeekMigrator` / `DeepSeekImporter`），
属于数据库与数据模型层面的大改，涉及旧数据兼容，**本阶段未迁移**，
留待单独评估（见"已知问题"）。

---

## 2. 对应官方 Commit / 版本

| 项 | 值 |
|---|---|
| 官方仓库 | `rikkahub/rikkahub` |
| 分支 | `master` |
| Commit | `2435dbdf4690fe26d424b8d1ab778bcde9c6cd75`（3.3.1） |
| 共同祖先 | `2689e753afc97c69fc5044bcd9fc963ecbb175db` |

---

## 3. 新增 / 修改的关键文件和模块

**新增（从官方迁移）：**

| 文件 | 说明 |
|---|---|
| `ui/pages/quickstart/QuickStartPage.kt` | 页面骨架（简化为单标签） |
| `ui/pages/quickstart/QuickStartGeneralTab.kt` | 通用配置引导（服务商/模型/搜索/TTS） |
| `ui/pages/quickstart/QuickStartComponents.kt` | 步骤徽章、状态胶囊、stepItem 组件 |
| `ui/pages/quickstart/QuickStartCard.kt` | 快速入门卡片 |
| `ui/pages/quickstart/QuickStartVM.kt` | 状态与 setDefaultChatModel |
| `ui/components/ui/PagerTabs.kt` | 官方分页标签组件（主体原缺） |

**修改（适配主体）：**

| 文件 | 改动 |
|---|---|
| `RouteActivity.kt` | +`Screen.QuickStart`、+路由 entry（纯新增，不动已有 Screen） |
| `SettingPage.kt` | 顶栏加火箭入口 |
| `ui/components/ui/CardGroup.kt` | 升级到官方版本（+186/−11）：新增 `formItem`/`switchItem` 扩展；主体 36 个使用方兼容 |
| `ui/components/ai/ModelList.kt` | 补入官方 `ModelField` 组件 + 所需 import |
| `DefaultProviders.kt` | +`DEEPSEEK_PROVIDER_ID` 常量（复用主体已有同 UUID） |
| `strings.xml` | +49 个 `quick_start_*` 字符串 |
| `gradle/libs.versions.toml` | huge-icons 1.4 → 1.5（与官方一致） |

**移除（适配后不需要）：** `ConversationConfig.kt`、`DeepSeekMigrator.kt`、`DeepSeekImporter.kt`、`QuickStartDeepSeekTab.kt`、相应字符串/常量。

---

## 4. GMYSJ 原有功能的保留与适配

| 资产 | 状态 |
|---|---|
| Agent 系统 / 执行流程 | 未改动 |
| Device Tools / 手机自动化 | 未改动 |
| Shizuku | 未改动 |
| Workflow / Schedule | 未改动 |
| Telegram | 未改动 |
| Browser / Web Search | 未改动 |
| Workspace / SSH | 未改动 |
| Skills / Sub-Agents / MCP | 未改动 |
| Doctor / HARDLINE | 未改动 |
| 远程节点 / win-bridge / project-docs | 未改动 |
| 已有 Screen 路由 | **仅新增，未删改任何已有入口** |

`CardGroup.kt` 被 36 个文件使用，升级为官方版本后经 A 级验收确认兼容。

---

## 5. CI 编译结果 / 测试结果

**CI #49**：[链接](https://github.com/GMYSJ/rikkahub-agent-gm/actions/runs/44962748105)

| 项 | 结果 |
|---|---|
| 结论 | **success** |
| 步骤 | 23 步全部成功，无异常 |
| versionCode 守卫 | success（仍为 190，覆盖安装能力保持） |
| 单元测试 | **2031 例通过**（ai 308 + app 1723），0 失败 |
| APK | `RikkaHub-run49-arm64`，50.18 MB |

中途失败的 run（已修复，保留记录）：
- #47：缺 `DeepSeekImporter` + 数据模型不兼容
- #48：仅缺 `clickable` import（已补）

---

## 6. 验收等级

| 等级 | 状态 | 说明 |
|---|---|---|
| **A：编译 + 单测** | ✅ **通过** | CI #49，2031 测试全过 |
| B：模拟器 / 自动化测试 | ❌ 未做 | 本机无模拟器环境 |
| C：真机测试 | ❌ 未做 | 本机无 ADB |

**不宣称功能已在真机验证。** 用户可见变化基于代码路径与 CI 编译通过推断。

---

## 7. APK 构建产物及获取方式

- GitHub Actions run #49 → artifact `RikkaHub-run49-arm64`
- 解压得到 `RikkaHub-2.5.1-agent.4-arm64-v8a.apk`
- 签名 keystore 未变、versionCode 固定 190 → **可直接覆盖安装**，出问题可装回任意旧包

⚠️ 该 APK 在功能分支 `feature/upstream-quickstart` 上构建，
尚未合并回 `integration/upstream-202611`。

---

## 8. 已知问题 / 下一阶段

**已知问题：**

1. **DeepSeek 迁移标签未移植** — 依赖官方 3.x `Conversation.config` 数据模型改造，
   涉及数据库迁移与旧数据兼容，需单独阶段处理。
2. **C 级验收缺失** — 需真机确认快速入门页的布局与交互。
3. huge-icons 升级到 1.5，CI 编译通过，但图标渲染需目视确认（C 级）。

**下一阶段计划：**

第一阶段剩余：迁移官方新 UI 的更多用户可见组件
（`ChatMessageAttachments`、`MarkdownParagraphs`、`ChatListSwipe` 等），
继续以"完整功能簇 + A 级验收"方式推进。

第二阶段：MediaGen（图片/视频创作）。

---

## 9. Git 状态

| 项 | 值 |
|---|---|
| 功能分支 | `feature/upstream-quickstart` |
| 本轮提交 | `b0faab6`(初版) → `f116bfe`(适配) → `8a2b3af`(编译修正) |
| 回滚点 | `backup/pre-uimigration-35e713e` tag |
| 集成分支 HEAD | `1874032`（未动） |
| 本地未推提交 | `35e713e78` fix(favorite)（按要求保留，未推送） |
---

## 追加：助手回复按段落拆气泡（官方 3.3.0，CI #49 后追加）

| 项 | 内容 |
|---|---|
| 官方来源 | 2435dbdf4（3.3.0 引入，3.3.1 保留） |
| 新增文件 | ui/components/message/MarkdownParagraphs.kt（Markdown 感知分段函数） |
| 修改文件 | ChatMessage.kt：助手气泡分支按段落拆成多个气泡 |
| 用户可见变化 | 助手较长回复按段落分多个气泡显示；代码块/公式不会被切断 |
| 数据兼容 | **未新增 DataStore 字段**（官方用 splitAssistantBubbleByParagraph 开关，主体无此字段；直接启用拆分，不改用户配置结构） |
| 提交 | 83dfc23d6 |
| CI | #50（进行中，见最新结果） |

此项与快速入门页同属第一阶段 UI 体验迁移，均为纯 UI 层改动，
未触碰 Agent/工具/设备自动化/Shizuku/Workflow/Telegram/Workspace/MCP/Doctor/HARDLINE/远程节点。
---

## 待迁移功能登记：DeepSeek QuickStart（不得放弃）

| 项 | 内容 |
|---|---|
| 功能 | 快速入门页的「从 DeepSeek 迁移」标签 |
| 官方来源 | 2435dbdf4（3.3.1） |
| 涉及文件 | ui/pages/quickstart/QuickStartDeepSeekTab.kt、data/sync/importer/DeepSeekMigrator.kt、DeepSeekImporter.kt、data/model/ConversationConfig.kt |
| 当前状态 | **未迁移**（本阶段只迁了通用配置标签） |
| 阻塞原因 | 依赖官方 3.x 给 Conversation 新增的 config 字段；主体 2.5.1 数据模型与数据库无此字段，硬搬会导致 ConversationConfig.kt 十余处 Unresolved reference |
| 后续计划 | 单独阶段研究 Conversation.config 数据结构、Room Migration 与旧数据兼容方案；验证通过后再迁移该标签。**不允许直接放弃** |
| 风险 | 数据结构变更涉及全部旧会话，必须先备份 + 幂等迁移 + 回滚测试 |

---

## 拆气泡开关修正（用户要求）

用户要求：不要永久改变所有用户的默认显示行为。

处理：
- DisplaySetting 新增独立字段 splitAssistantBubbleByParagraph: Boolean = false
  （@Serializable data class 存单个 DataStore key，旧配置反序列化自动用默认值 **false**）
- ChatMessage 按官方逻辑读取该开关；默认关闭时保持原来的单气泡
- 设置页在「显示助手气泡」开启时，显示「按段落拆分气泡」开关
- 默认行为与迁移前完全一致，老用户无感

这也满足官方设计：官方同名字段默认值同为 alse。
---

## 追加：聊天附件按压反馈（官方 3.x，待 CI 验收）

| 项 | 内容 |
|---|---|
| 官方来源 | 2435dbdf4（3.3.1） |
| 新增文件 | ui/components/message/ChatMessageAttachments.kt（自包含组件：animatePressProgress / ChatMessageMediaTile / ChatMessageFileChip / openLocalFile） |
| 修改文件 | ChatMessage.kt：文档附件胶囊接入 nimatePressProgress，按压时圆角由 50 收缩到 30 |
| 用户可见变化 | 点击聊天中的文档附件时，胶囊有圆角收缩的按压反馈 |
| 提交前自检 | 无 UTF-16、符号齐全、import 完整、覆盖安装守卫在、GMYSJ 资产完好 |

**未迁移项登记（不得放弃）：**

| 功能 | 原因 | 后续 |
|---|---|---|
| ChatMessageNotices.kt（消息通知条展示） | 依赖主体缺失的 UIMessagePart.Notice 数据类型 | 与 Conversation.config 一样，属于数据模型层改造，单独阶段评估旧数据兼容后迁移 |

说明：主体 ChatMessage 已有等价的图片/文档渲染，因此未整体替换官方附件组件，
只迁移按压反馈这一低风险、可见的改进；其余组件作为可复用基础已就位。
---

## 验收记录更新（按构建版本区分）

| run | commit | 内容 | 结果 |
|---|---|---|---|
| #49 | 8a2b3af | 快速入门页（无拆气泡） | ✅ success |
| #50 | 83dfc23 | 拆气泡首次实现（无开关，永久启用） | ✅ success |
| #51 | 3906f58 | 拆气泡独立开关（默认关闭）+ 附件按压反馈 | ✅ success |
| #52 |  eb2ea1 | MediaGen 引擎模块 | 进行中 |

**#49 / #50 / #51 是三个独立构建版本，不混用验收结论。**
最终推荐版本：#51（拆气泡可开关，默认行为不变）。

## 第二阶段进度：MediaGen 引擎已落地，UI 待接线

- 已迁移：mediagen/ 全模块 35 文件（5 家 Provider 的图片/视频生成引擎）
- settings.gradle 已 include :mediagen
- **尚未产生用户可见功能**：缺 app 侧 MediaCreation UI 7 文件 + Provider 设置接线
- UI 阻塞根因：依赖主体缺失的 MediaCreationRepository / MediaCreationService /
  MediaCreationRecord / AppScope 等 3.x 数据层，需单独阶段评估
- 已登记待迁移：DeepSeek QuickStart、ChatMessageNotices（均依赖主体缺失的数据模型）
---

## MediaGen UI 接线阻塞分析（2026-11-22，只读核实）

引擎层（mediagen/ 35 文件）已迁移并通过 #52 A 级验收，但 **app 侧 UI 与数据层尚未接入**，原因经实测确认：

### 数据库版本差距（核心阻塞）

| 项 | 主体 | 官方 |
|---|---|---|
| AppDatabase version | **31** | **34** |
| MediaCreation 表 | 无 | 3 个新 Entity：media_creation_session / node / record |
| Migration | 主体有 Migration_30_31 | 官方改为 Migration_28_29(spec) + 31→32 + 32→33(spec) + 33→34 |

### 为什么暂不接线

- MediaCreation UI 7 文件依赖 MediaCreationRepository / MediaCreationService /
  MediaCreationRecord / MediaCreationSession / MediaCreationDraft 等数据层，
  这些又依赖上述 3 张新表。
- 接入必须把 AppDatabase 从 31 升到 34，并替换 28→29 的 migration spec。
- 这直接触碰**用户现有对话数据库**。用户明确要求不得丢工作区数据、不得破坏旧数据兼容，
  且本机无真机（无法做 C 级数据迁移验证）。
- 因此按红线暂缓，不把数据库升级混进 UI 迁移。

### 后续计划（不得放弃）

1. 单独阶段：备份主体数据库 schema，逐条比对 31→34 的 4 个 migration 与主体的差异。
2. 验证 Migration_28_29 spec 替换是否影响主体已有的 28→29 数据。
3. 设计幂等迁移 + 回滚方案，在 CI 增加数据库迁移测试。
4. 具备 C 级验证条件（备份 + 真机/模拟器）后再接 UI 与 Provider 设置。

**当前状态：MediaGen 引擎已就位但用户不可见；不得宣称图片/视频创作已可用。**
---

## ⚠️ 重要更正：数据库 schema 分叉（2026-11-22 实测，取代上文评估）

上文「主体 31 升 34 只是加 3 张表」的判断是**错误的**，以本段为准。

### 实测证据（读取双方 Room schema JSON）

| 项 | 主体 31.json | 官方 31.json |
|---|---|---|
| 字节数 | 39535 | 31608 |
| Entity 数 | **16** | **14** |

**主体独有 9 张表**：MemoryEntity / gent_runs / conversation_compaction /
scheduled_job_runs / scheduled_jobs / ssh_hosts / 	elegram_chats /
workflow_runs / workflows

**官方有而主体无 7 张表**：media_creation_node/record/session /
memory_consolidation / memory_file / 	ranslation_history / usage_record

**官方 31→34 的表变化**：30→31 只加 usage_record，31→32 / 32→33 / 33→34 **均无加表**。
即官方的 media 表在更早版本就存在，主体则完全没有。

### 结论

双方数据库 schema 从很早就深度分叉。照搬官方 Migration_28_29/32_33 spec
与 schema JSON 会把官方的 migration 应用到主体的不同表结构上，
**可能导致用户数据错乱或应用启动崩溃**。这触碰「不丢工作区数据」红线。

### 已采取措施

- CI #53 因缺 32.json/33.json schema 失败（KSP AutoMigration 校验）
- 已尝试补官方 schema，但发现与主体 31.json 不兼容
- **已回退** db4a8999f（危险的数据库升级），保留 tag
  ackup/pre-mediacreation-a3c6ae626 作为完整尝试记录
- 分支已 reset 回 3c6ae626（#52 后的安全状态）

### 后续（不得放弃，但需专门阶段）

要让媒体创作真正可用，必须：
1. 基于**主体的 31 schema** 手写 migration 加 media_creation 3 表（version 31→32）
2. 用本机或 CI 生成主体自己的 32.json schema
3. 在模拟器/真机上用**真实旧数据**验证迁移与回滚（C 级）
4. 全部通过后才接 UI 与 Provider 设置

在此之前，媒体创作功能保持「引擎已就位、不可见」状态，不得宣称可用。

---

## 媒体创作完整接入尝试：最终结论（2026-11-22）

上一节「手写 Migration 方案」是中间过程。这里记录最终结论。

### 尝试过程

| run | 结果 | 失败根因（逐轮读取完整日志） |
|---|---|---|
| #53 | failure | AutoMigration 缺 32/33 schema JSON；且双方 schema 早已分叉 |
| #54 | failure | app 模块看不到 `:mediagen` 类（509 错误同一根因） |
| #55 | failure | 34 个缺失符号：设置页定义文件、StringUtils/常量未搬 |
| #56 | failure | 39 个符号：setting_media_* 字符串、路由、S3 字段差异 |
| #57 | failure | 错误不再收敛，集中在**两个系统性不兼容**：Toast 体系（主体 `com.dokar.sonner` vs 官方 `me.rerere.ui.toast`）与 Settings 数据模型（`mediaGenerationProviders`/`uploadS3Config`/`MEDIA_CREATION` 主体均无） |

### 最终决定

完整尝试已冻结在 tag `backup/mediacreation-fullattempt-b114e08`（含全部代码与 5 轮 CI 分析）。
分支已回到 `0a7f6c8ed`（#52 后的已验证状态）。

**理由**：媒体创作 UI 依赖 3.x 的 Toast 组件体系与 Settings 数据模型整体改造。
这不是"补几个文件"能收敛的——每轮 CI 都暴露新的系统性差异，第 5 轮错误已不再下降。
继续硬改会触碰用户设置数据结构，违反「不破坏用户数据」红线，
且本机无真机无法做 C 级验证。

### 当前可用功能（均已 A 级验收）

| run | 内容 |
|---|---|
| #49 | 快速入门页 |
| #51 | 拆气泡开关（默认关）+ 附件按压反馈 |
| #52 | MediaGen 引擎（代码就位，用户不可见） |

### MediaGen 引擎为何不可见

引擎层（5 家 Provider 的图片/视频生成）已编译通过，
但缺 app 侧 UI 与 Provider 设置；其依赖的 3.x Toast/Settings 体系
与主体不兼容，需独立阶段做「组件体系 + 数据模型适配」，
并配 C 级验证后才能安全接入。**不得宣称媒体创作已可用。**

---

## 追加：三个用户可见 UI 改进（CI #58 已验收成功）

在不触碰数据模型的前提下，批量移植官方 3.x 的三个纯 UI 改进：

| 官方 Commit | 功能 | 文件 | 用户可见变化 |
|---|---|---|---|
| `48a68f873` | 模型名最多两行 | `ModelList.kt` | 长模型名不再被截断成一行 |
| `97060dd51` | 输入栏底部渐变遮罩 | `ChatInput.kt` | 消息不再从系统导航栏/键盘后透出 |
| `a6abed3be` | 搜索引用角标实色背景 + Medium 字重 | `Markdown.kt` | 暗色模式下引用角标可读 |

提交 `9b85804ef`（17 行新增，2 行删除），提交前自检通过。
本机无 Java/Gradle，A 级以 CI 为准；B/C 级未做。

**CI #58 结果**：success，23 步全绿，2031 测试通过，APK `RikkaHub-run58-arm64` 50.18MB，versionCode 守卫 success。A 级通过；B/C 级未做。
