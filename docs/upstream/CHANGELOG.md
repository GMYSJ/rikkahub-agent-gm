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
