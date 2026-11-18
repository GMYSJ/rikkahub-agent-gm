# RikkaHub Agent × DeepSeek Harness 融合工程

> **新对话请先读 `project-docs/INDEX.md`。**

本目录是 RikkaHub Agent 源码 + 本项目工程管理文档。

## 目录结构

```
rikkahub-agent-gm/
├── project-docs/          ← 本项目管理文档（先读这里）
│   ├── INDEX.md           开工索引（第一站）
│   ├── PROJECT_STATUS.md  进度与待办
│   ├── BLOCKERS.md        阻塞项
│   ├── PROJECT_AUDIT.md   源码审计
│   ├── ARCHITECTURE.md    架构设计
│   ├── FEATURE_MATRIX.md  功能处置矩阵
│   ├── COMPATIBILITY_REPORT.md  版本兼容
│   ├── ENVIRONMENT_REPORT.md    环境审计
│   ├── DECISIONS.md       架构决策
│   ├── TEST_REPORT.md     测试记录
│   └── CHANGELOG.md       变更日志
│
├── app/ ai/ workspace/ ...  ← RikkaHub 源码（ZIP 快照，无 .git）
├── .github/workflows/build-android.yml  ← 现有 CI（JDK 21，可直接用）
└── README.md               ← 本文件
```

## 项目目标

以 RikkaHub Agent 为唯一移动端 UI 主体，融合 DSH 的双向 Agent 能力、工具、模型与工作区。
主提示词：`D:\AAAQQ文件\RikkaHub_DSH_融合工程总提示词-1.md`

## 当前状态

**阶段 0 完成（源码审计 + 架构设计），可进入阶段 3 开发。**

详见 `project-docs/PROJECT_STATUS.md`。

## 环境速查

| 项 | 值 |
|---|---|
| 宿主 | Windows 11 IoT LTSC 26200 / Ryzen 9 7945HX / 15.7GB |
| DSH | `0.2.2-rc.5` @ `D:\AAAdeepseek\Harness` |
| Profile | `desktop` |
| Node / pnpm | `v24.22.1` / `11.28.5` |
| Python | `D:\Python311\python.exe` |
| 构建 | **GitHub Actions，JDK 21** |
| 本地编译链 | java/adb/gradle/git 均无 |

## 源码说明

源码来自 `https://github.com/GMYSJ/rikkahub-agent-gm` master 分支 ZIP 快照（2026-11-18）。

**本机无 git，所以没有 `.git` 目录。** 影响：
- 不能 `git diff` / `git log` / 建分支
- 不能直接 push
- 改动靠文件级备份（`*.bak-时间戳`）

需要版本控制时再解决（装 Git 或用网页端）。

## 红线

- ❌ 不修改 DSH 核心宿主与 `app.asar`
- ❌ 不动用户现有 13 个 DSH 插件与 bundles 顺序
- ❌ 不破坏 WorkBuddy 登录状态
- ❌ 不提交任何 Token / 密钥 / 证书私钥
- ❌ DSH 重启只能走 `schtasks /Run /TN "DSH静默重启"`

## 编码注意

本机 PowerShell 是 **5.1**（非 Core），默认按 GBK 解码。

**读取任何 UTF-8 文件必须加 `-Encoding UTF8`**，否则中文乱码（文件本身没问题）。

写入用：
```powershell
[System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))
```
