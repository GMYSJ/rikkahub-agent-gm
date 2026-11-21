# 首次融合审计报告

> 阶段 A 交付物。所有结论均有 git 命令输出作为依据。
> 日期：2026-11-22

## 1. 环境核实（实测，非历史记忆）

| 项 | 结果 |
|---|---|
| OS | Windows 11 IoT Enterprise LTSC |
| git | ✅ `2.56.1.windows.1`（便携版，`工作区/tools/git`） |
| java / gradle / adb | ❌ 均无 |
| 构建通道 | GitHub Actions（JDK 21） |
| 现有工作流 | `.github/workflows/build-android.yml`（2.8 KB） |
| GitHub 身份 | `GMYSJ`（token 可读 `api.github.com/user`） |
| 官方仓库可达 | ✅ `rikkahub/rikkahub`，9079 stars，922 forks |

## 2. Git 拓扑核实

| 检查 | 结果 |
|---|---|
| 本地 HEAD 分支 | `verify/inbuilt-20261119` @ `3b2c966` |
| 该分支性质 | **重新 `git init` 的压缩快照**（51 提交，根提交 `c4e6e87`） |
| `merge-base HEAD official/master` | **空** → 与官方无共同祖先 |
| `merge-base origin/master official/master` | `2689e753`（非空）→ **真实 fork 有共同祖先** |
| 本地 `master` @ `2f302a5` | 10 提交，是快照分支的祖先，同样无共同祖先 |
| 远端 `origin/master` @ `931345c` | 真实历史，含 3507 提交 |
| 远端 `origin/verify/inbuilt-20261119` | `3b2c966`，与本地一致 |

**结论**：真实可用的同步基线是 `origin/master`，不是本地任何分支。
本地曾长期在快照分支上开发。

### 数量核实

| 指标 | 数值 |
|---|---|
| 官方 `2.5.1`..`master` 提交数 | 332 |
| 官方 `2.5.1`..`master` 变更文件 | 300 |
| 主体相对共同祖先的提交 | 663 |
| 官方相对共同祖先的提交 | 332 |
| **双方都改过的文件（真冲突面）** | **282** |
| `origin/master` vs `3.3.1` 文件变更 | 2010（+269048 / −800802） |

## 3. 上游版本核实

| 项 | 值 |
|---|---|
| 官方最新 Tag | `3.3.1`（2026-11-21T14:31:21Z） |
| 官方 master HEAD | `2435dbd`（2026-11-21T13:52:21Z） |
| 官方 versionName / versionCode | `3.3.1` / `198` |
| 主体 versionName / versionCode | `2.5.1-agent.4` / `190` |
| 主体最后同步官方 Tag | `2.5.1` |

跨 **2.5.1 → 3.3.1**，含 3.0.0 大版本重构。

## 4. 三个上游来源的关系

| 仓库 | 性质 | 状态 |
|---|---|---|
| `rikkahub/rikkahub` | 官方主线 | 3.3.1，最活跃 |
| `ExTV/rikkahub-agent` | 官方 fork（`fork: true`, `parent: rikkahub/rikkahub`） | 停更在 `v2.5.1-agent.1`（2026-09-24） |
| `GMYSJ/rikkahub-agent-gm` | 本项目主体 | `2.5.1-agent.4` + 独有 Agent 能力 |

**结论**：不能只跟踪 `ExTV`（已落后官方主线 2.5.1→3.3.1 全部内容），
必须以 `rikkahub/rikkahub` 为主同步源。

## 5. 模块结构

### 主体独有（官方没有）

| 模块 | 说明 |
|---|---|
| `highlight` | 代码高亮 |
| `local-llm` | 本地 LLM |
| `llama-cpp` | llama.cpp 绑定 |
| `videogen` | 视频生成 |
| `locale-tui` | 本地 TUI |
| `trace-cli` | 追踪 CLI |

### 官方新增（主体没有）

| 模块 | 说明 |
|---|---|
| `terminal` | 工作区终端 |
| `ui` | UI 模块（从 app 拆出） |
| `mediagen` | 媒体创作（图片+视频） |
| `app:baselineprofile` | Baseline Profile |

### 独有能力文件数（`git ls-tree` 实测）

| 能力 | 主体 | 官方 |
|---|---|---|
| `data/ai/tools` | **91** | 19 |
| Device tools (`tools/local`) | 75 | 11 |
| Shizuku | **11** | 0 |
| Workflow | **38** | 2（仅字样） |
| CronJob | 9 | 0 |
| SubAgent | 12 | 0 |
| Telegram | **31** | 0 |
| Doctor | 9 | 0 |
| Hardline | 4 | 0 |
| Accessibility | 4 | 2 |
| MCP | 11 | 有（实现对不上） |
| Skills | 72 | 有 |

**结论**：Agent/自动化能力是主体核心价值，官方覆盖接近零。这不是"两个相似项目的合并"，
而是"给一个大得多的 Agent 产品换内核"。

## 6. 已完成的基础设施修复

| 项 | 状态 |
|---|---|
| 加入 `origin` remote 并 fetch | ✅ |
| 加入 `official` remote 并 fetch（blobless + tags） | ✅ |
| 克隆官方只读副本 → `repos/rikkahub-upstream` | ✅ |
| 验证真实 fork 的历史与祖先 | ✅ |
| 建立 `integration/upstream-202611` | ✅ |
| 把快照分支成果重接到真实历史（2 个语义提交） | ✅ |
| 验证 `app/` 代码零丢失（diff 为 0） | ✅ |

**关键产物**：`integration/upstream-202611` @ `4a77cdb`
- `d384a11` `feat(remote-node)`：远程节点 4 文件 + 4 个集成触点
- `4a77cdb` `chore`：`win-bridge/`（34 文件）+ `project-docs/`

## 7. 风险清单（按严重度）

| # | 风险 | 严重度 | 状态 |
|---|---|---|---|
| 1 | Phone Use 与 91 个设备工具争抢无障碍服务 | **极高** | 未解决，已定调度层方案 |
| 2 | Tool Calling 协议被官方重构（`e10e104`） | **极高** | 未解决 |
| 3 | 上下文压缩吞掉 Agent 长任务状态 | 高 | 未解决，已定约束 |
| 4 | Memory 数据结构不兼容（3.0.0 文件化） | 高 | 未解决 |
| 5 | `release.keystore` 被 git 跟踪 | 高 | 已记录，未动 |
| 6 | UI 全改版可能藏起 GMYSJ 入口 | 高 | 已定约束 |
| 7 | 官方依赖不可照搬（`-SNAPSHOT` / `mavenLocal`） | 中 | 已记录 |
| 8 | Workspace 任务 ID / 会话语义漂移 | 中 | 未解决 |
| 9 | 本机无编译链，验证依赖 CI | 中 | 已确认 |

## 8. 本机与仓库的凭据状况

- `release.keystore` 在 `origin/master` 与主体中**被跟踪**，官方没有。
- GitHub token 存于 `~/.secrets/github_token.txt`（主体 `tools/gh-api.sh` 设计如此，不打印 token）。
- 主体 `.gitignore` 已排除 `app/google-services.json`、`.claude/`、`**/AGENTS.md` 等。
- 未发现 `.git-credentials` / `gh hosts.yml` / `.netrc`。

## 9. 下一步（阶段 B 已完成，进入 C）

阶段 B（集成分支 + 回滚点）已完成。阶段 C 从**低风险、可独立测试**的项开始：

1. **MCP 三项修复**（`cf79246` `$ref` 内联、`4ba5d79` OAuth 回退、`42896e5` 列表崩溃）——
   相对独立，不触碰 Agent 工具执行链。
2. **Provider/流式健壮性修复**（`1575d17` 空 role、`240deb5` null 行）——
   纯防御性，收益高、风险低。
3. **备份/导入崩溃修复**（`a8508e2`）。
4. 之后才进入 Phone Use 架构对照（阶段 E）。

**不做的**：整体 merge、直接覆盖、先做 UI。
