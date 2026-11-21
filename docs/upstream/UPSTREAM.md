# 上游同步规范 / UPSTREAM

> 本文件是长期跟进官方 RikkaHub 的**唯一事实来源**。任何同步轮次都必须先读它，结束后更新它。

## 1. 仓库身份

| 项 | 值 |
|---|---|
| 主体仓库（最终产品） | `GMYSJ/rikkahub-agent-gm` |
| 主体默认分支 | `master` |
| 主体跟踪分支 | `integration/upstream-YYYYMM`（每轮一轮） |
| 官方上游 | `rikkahub/rikkahub` |
| 官方上游分支 | `master` |
| 上游远程名 | `official` |
| 主体远程名 | `origin` |
| 基线来源 fork | `ExTV/rikkahub-agent`（`fork: true`，`parent = rikkahub/rikkahub`） |

## 2. Git 拓扑（2026-11-22 核实）

这是本项目**最容易踩错的点**，务必先理解：

```
2689e75 (feat: 支持读取AGENTS.md, 2026-09-10)   ← 真正的共同祖先
├── official/master ──── 332 commits ──── 2435dbd (3.3.1, versionCode 198)
└── origin/master  ──── 663 commits ──── 4a77cdb (2.5.1-agent.4 + 本轮整理)
```

### ⚠️ 历史断层（已修复，别重犯）

| 分支 | 性质 | 与官方的关系 |
|---|---|---|
| `origin/master` | 真实 Git 历史（fork 自官方） | ✅ 有共同祖先 `2689e75` |
| `verify/inbuilt-20261119` | **重新 `git init` 的压缩快照**，51 个提交 | ❌ 完全无共同祖先 |
| `integration/upstream-202611` | 从 `origin/master` 拉出，已接回项目成果 | ✅ 可正常 merge |

**教训**：曾有一段时间工作区检出的 `verify/inbuilt-20261119` 是从 ZIP 快照重新提交的空历史分支。
在其上做 `git merge official/master` 会得到「unrelated histories」，即使用
`--allow-unrelated-histories` 也会产生数千个假冲突。

已于本轮把项目成果（远程节点功能、`win-bridge/`、`project-docs/`）重接到
`origin/master` 真实历史上，形成 `integration/upstream-202611`。
`app/` 代码与旧快照分支逐字节一致（`git diff --stat` 为 0），因此**没有丢失任何工作**。

**规则：任何同步操作只能在有共同祖先的分支上进行。**
开工先跑：

```bash
git merge-base HEAD official/master   # 必须返回一个 SHA，而不是空
```

## 3. 同步基准

| 字段 | 内容 |
|---|---|
| Upstream URL | https://github.com/rikkahub/rikkahub |
| Upstream branch | `master` |
| **Last synced tag** | `2.5.1` |
| **Last synced commit** | `a9b35ba2f1b0f1b2211f78da3cc43555b332294d`（tag `2.5.1`） |
| **Last sync date** | 2026-11-22（本轮为首次正式同步，仅完成审计） |
| **Base repository commit** | `4a77cdba0afdc436325ffa893d69146b977da877` |
| **Target upstream commit** | `2435dbdf4690fe26d424b8d1ab778bcde9c6cd75`（3.3.1） |
| **Pending features** | 332 个官方提交待评估，见 `FEATURE_MATRIX.md` |
| **Known conflicts** | 见 `CONFLICTS.md` |

### 版本差

| | versionName | versionCode |
|---|---|---|
| 主体（当前） | `2.5.1-agent.4` | 190 |
| 官方（3.3.1） | `3.3.1` | 198 |

跨了 **2.5.1 → 3.3.1**，其中 `3.0.0` 是官方的大版本重构（全新 UI + 记忆库 + 上下文压缩机制改写 + 媒体创作），
是同步难度最高的一段。

## 4. 同步通道选择

| 通道 | 说明 | 结论 |
|---|---|---|
| `rikkahub/rikkahub` | 官方主线，功能最全（3.3.1） | ✅ **主要同步源** |
| `ExTV/rikkahub-agent` | 官方 fork，带 Agent 特性，但停在 `v2.5.1-agent.1`（2026-09-24） | ⚠️ 仅作参考，已落后官方主线 |
| 直接 merge 官方 | 因 3.0.0 大重构 + 主体有 75 个独有工具文件，冲突面巨大 | ❌ 不可整体 merge |

**策略结论：模块级移植 + 显式适配 + 独立提交**，不做整体 merge。

## 5. 每轮同步必做的检查

```bash
# 1. 拉取最新
git fetch official --tags --filter=blob:none

# 2. 确认祖先仍然存在
git merge-base HEAD official/master

# 3. 官方新提交
git rev-list --count HEAD..official/master

# 4. 官方最新 tag
git describe --tags --abbrev=0 official/master

# 5. 官方 Release Notes（用 API，见 SYNC_TEMPLATE.md）
```

**不能用 Release Tag 当唯一基准** —— tag 之后官方仍在 master 上继续修复。
基准必须记到 **Commit**。

## 6. 分支约定

| 分支 | 用途 |
|---|---|
| `master` | 稳定可构建主体（发布用） |
| `integration/upstream-YYYYMM` | 某一轮官方同步的集成分支 |
| `feature/upstream-<功能名>` | 单个功能的独立移植分支 |
| `hotfix/<问题>` | 紧急修复 |

不擅自改名或删除现有分支。不要删除 `verify/inbuilt-20261119`
（它保留了快照期的 51 个提交，是历史证据；但**不要在其上继续开发**）。

## 7. 已知环境约束

| 项 | 状态 |
|---|---|
| Windows 11 IoT Enterprise LTSC | ✅ |
| git（便携版 `工作区/tools/git`） | ✅ 2.56.1 |
| java / gradle / adb | ❌ 本机没有 |
| **构建方式** | **GitHub Actions（JDK 21）** |
| 现有工作流 | `.github/workflows/build-android.yml` |

不得要求用户安装 Android Studio 工具链。不得用来源不明的预编译 APK 替代源码构建。
