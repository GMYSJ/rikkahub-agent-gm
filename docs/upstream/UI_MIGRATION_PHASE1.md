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
