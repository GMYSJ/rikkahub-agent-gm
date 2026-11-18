# 功能矩阵 / FEATURE MATRIX

> 阶段 0 产出。标注每项能力的现状与处置方式。
> 图例：✅ 可直接复用 ｜ 🔧 需适配 ｜ 🆕 需新开发 ｜ ⚠️ 受上游限制 ｜ ❌ 不做

## A. 手机端（RikkaHub 原有）

| 能力 | 现状 | 处置 |
|---|---|---|
| Compose UI / 聊天界面 | ✅ | 保留，仅新增入口 |
| Agent 推理循环 | ✅ | 保留，不改内核 |
| `Tool` 抽象 | ✅ | 复用，作为远程代理的载体 |
| `ChatToolFactory` 工具注入 | ✅ | 扩展点，追加远端工具 |
| `ProviderManager` 模型管理 | ✅ | 扩展点，追加远端 Provider |
| 90+ 设备工具 | ✅ | 保留；远程暴露走白名单 |
| Shizuku（AIDL + UserService） | ✅ | 保留；远程调用必须二次确认 |
| Workspace（proot Linux） | ✅ | 保留；远程访问走 `WorkspaceFileSystem` |
| MCP 客户端（`McpManager`） | ✅ | **直接复用**接 DSH |
| 模型供应商（OpenAI/Claude/Google） | ✅ | 保留 |
| 记忆 / Skills / 工作流 / 子 Agent | ✅ | 保留 |
| 设置 / 权限 / 主题 | ✅ | 保留，新增远程设置页 |

## B. 手机 → 电脑（新增）

| 能力 | 现状 | 处置 |
|---|---|---|
| 设备配对 | 🔧 | 复用 dsh-mobile 配对机制 |
| 局域网连接 | ✅ | 复用 `https://192.168.1.3:3443` |
| cpolar 远程 | ✅ | 动态读 `origin`，禁硬编码 |
| 会话读取 | 🔧 | 需适配 DSH 会话 API |
| 消息收发 / 流式 | 🔧 | 需适配 DSH SSE |
| 调用 DSH PowerShell | 🆕 | 需 DSH 侧暴露 MCP 工具 |
| 读写电脑工作区 | 🆕 | 需 DSH 侧 `fs_*` MCP 工具 |
| 跨端文件传输 | 🆕 | 分块 + 断点续传 |
| 断线重连 | 🆕 | 重连 + 任务恢复 |

## C. 电脑 → 手机（新增）

| 能力 | 现状 | 处置 |
|---|---|---|
| 手机 MCP Server | 🆕 | Ktor CIO + SSE |
| 暴露 Shizuku | 🆕 | 白名单 + 二次确认 |
| 暴露截图/通知 | 🆕 | 白名单 |
| 读写手机 Workspace | 🆕 | 走 `WorkspaceFileSystem` |
| DSH 侧 MCP 客户端 | ✅ | DSH 有 `dsh-mcp-client` |
| DSH 插件封装 | 🆕 | `dsh-mobile-bridge` 插件 |

## D. 统一模型

| 能力 | 现状 | 处置 |
|---|---|---|
| 手机模型发现 | ✅ | 从 `ProviderManager` 读 |
| 电脑模型发现 | 🆕 | 从 DSH `/v1/models` 读 |
| 跨端模型代理（手机用电脑模型） | 🆕 | 包装为 `Provider`，转发 OpenAI 兼容请求 |
| 跨端模型代理（电脑用手机模型） | 🆕 | 手机侧暴露 `/v1/chat/completions` |
| 模型去重 | 🆕 | 按 `(provider, modelId)` 去重 |
| 能力声明（图片/工具/流式） | 🔧 | 从两端现有元数据聚合 |

## E. UI

| 能力 | 现状 | 处置 |
|---|---|---|
| 设备管理页 | 🆕 | 新页面 |
| 连接配置页 | 🆕 | 新页面 |
| 执行节点选择器 | 🆕 | 聊天页顶部 |
| 统一模型选择器 | 🆕 | 合并两端模型列表 |
| 工具来源标识 | 🆕 | 工具调用卡片加节点徽标 |
| 跨端任务列表 | 🆕 | 新页面 |
| 文件传输状态 | 🆕 | 通知 + 列表 |

## F. 已知缺陷（不复制）

| 缺陷 | 说明 | 处置 |
|---|---|---|
| 移动前端插件管理页空白 | `dsh-client-ui-plugin-manager` 激活失败 | 本项目不复用该前端，自建 UI |
| 文件单选 | dsh-mobile-app 无 `multiple` | 本项目实现多选 |
| Tailscale Funnel 不可用 | 进程连上即掉 | 不用，走 cpolar |

## G. 不做

| 项 | 理由 |
|---|---|
| WebView 嵌 DSH 页面 | 主提示词明确禁止 |
| 修改 DSH 核心 / app.asar | 红线 |
| 网络挂载工作区（SMB/WebDAV） | 复杂脆弱，改用 MCP 文件工具 |
| 暴露全部 90+ 工具 | 安全风险 |
| 自研传输协议 | 复用 MCP |
