# dsh-mobile-bridge

RikkaHub（Android）× DSH（Windows）的**双向工具桥**。

把 DSH 的工具以 HTTP 端点暴露给手机，同时把手机的工具注册回 DSH 让模型可调。
两个方向共用同一套端点 —— 两端装同一个插件即可互调。

## 为什么不用 MCP

实测结论（DSH 0.2.2-rc.5）：运行时只打包了 `@modelcontextprotocol/client`，
`server` 根本不存在，全仓也没有任何自建 MCP 服务端实现。
所以「让 DSH 当 MCP Server」这条路不存在，本插件改用一个可完整测试的极简 HTTP 协议。

详见 [PROTOCOL_SPEC.md](../../project-docs/PROTOCOL_SPEC.md)。

## 快速开始

### 1. 安装

把本目录作为 bundle 安装到 profile（**不要**手工改 profile 的 `package.json` 或 `cordis.patch.yml`）：

```
Plugins → Add plugin → 选择本目录
```

或用 `plugin_manager` 工具的 `install_bundle` 动作。

### 2. 打开

默认 `enabled: false` —— **端点一旦挂上就是局域网可达的攻击面**，必须显式打开。

在 profile 的 `cordis.patch.yml` 里把 `plugin-mobile-bridge` 行的 `enabled` 改成 `true`。

> ⚠️ 新增行必须用 `- insert:`（项目红线）。覆盖已有行才能用裸行。

### 3. 验证

```powershell
# 端口每次重启会变，从正在运行的 DSH 读，不要硬编码
$port = (Get-NetTCPConnection -State Listen |
  Where-Object { $_.OwningProcess -in (Get-Process 'DeepSeek Harness').Id -and $_.LocalPort -lt 60000 } |
  Select-Object -First 1).LocalPort
Invoke-RestMethod "http://127.0.0.1:$port/dsh-mobile-bridge/health"
```

## 端点

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/dsh-mobile-bridge/health` | 探活（不需要 token） |
| `GET` | `/dsh-mobile-bridge/tools` | 列出可调用的工具 |
| `POST` | `/dsh-mobile-bridge/tools/call` | 执行工具 |
| `POST` | `/dsh-mobile-bridge/register` | 远端注册自己的工具 |
| `GET` | `/dsh-mobile-bridge/nodes` | 查看已注册节点 |
| **`POST`** | **`/dsh-mobile-bridge/mcp`** | **MCP 兼容端点（推荐手机用这个）** |

## 手机侧怎么接（推荐路径）

### 1. 配置（在 profile 的 `cordis.patch.yml`）

```yaml
- id: plugin-mobile-bridge
  config:
    enabled: true
    listenPath: /dsh-mobile-bridge
    selfNodeId: windows-dsh
    token: '<主入口令牌>'
    lan:
      host: '192.168.1.3'    # 改成你的 WLAN 地址
      port: 61420
      token: '<局域网令牌>'
```

### 2. 手机 RikkaHub 配置

```
设置 → MCP → 添加服务器
  transport: streamable-http
  url:       http://192.168.1.3:61420/dsh-mobile-bridge/mcp
  headers:   Authorization: Bearer <lan.token>
```

然后**务必**在 Assistant → MCP 里勾选该 server，否则工具不会出现。

### 3. 验证

```powershell
# 局域网可达性
Invoke-RestMethod "http://192.168.1.3:61420/dsh-mobile-bridge/health"

# 带令牌列工具
$t = '你的lan.token'
Invoke-RestMethod "http://192.168.1.3:61420/dsh-mobile-bridge/tools" -Headers @{ Authorization = "Bearer $t" }
```

支持的 MCP 方法：`initialize`、`notifications/initialized`、`ping`、
`tools/list`、`tools/call`，以及批量请求。

不实现：resources、prompts、sampling、roots、progress、服务端推送流
（`GET /mcp` 返回 405）。请求这些会得到 JSON-RPC `-32601`。

完整规格见 [PROTOCOL_SPEC.md](../../project-docs/PROTOCOL_SPEC.md)。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 是否挂载端点 |
| `listenPath` | `/dsh-mobile-bridge` | 端点前缀 |
| `selfNodeId` | `windows-dsh` | 本节点标识，写进 trace 头 |
| `token` | 未设置 | 主入口（webServer 回环）的令牌 |
| `timeoutMs` | `120000` | 单次工具执行超时，上限 600000 |
| `lan` | 未设置 | 可选：开一个**独立的局域网监听**（见下） |

### 局域网监听（手机接入必需）

DSH Desktop 的 webServer 只绑 `127.0.0.1`，手机在局域网里够不到。
所以桥支持另起一个独立监听：

```yaml
lan:
  host: '192.168.1.3'   # 必须是具体网卡地址；0.0.0.0 / 127.x 一律拒绝
  port: 61420
  token: '<至少16字符>'  # 与顶层 token 是两套独立凭据
```

**四条硬规则**（都有测试覆盖）：

| 规则 | 为什么 |
|---|---|
| 拒绝 `0.0.0.0` / `::` / `*` | 那会把桥暴露到**所有**网卡，包括可能的公网侧 |
| 拒绝 `127.x` / `localhost` | 绑回环等于没做这件事 |
| 强制 `lan.token`（≥16 字符） | 局域网暴露必须鉴权，否则拒绝启动 |
| `lan.token` 与 `token` 互不通用 | 独立入口用独立凭据，主 token 泄露不波及局域网 |

启动失败（端口占用、地址不存在）只会**记警告**，不影响主通道。

## 安全设计

- **不绕过审批**：工具执行走 `ctx.tools.execute()`，DSH 自己的审批与守卫流水线照常生效。
- **继承 RikkaHub 审批**：远端工具名一律 `mcp__<node>__<tool>`，这个前缀在 RikkaHub 侧默认要求人工批准。
- **循环防护**：每次转发跳数 +1，达到 2 直接拒绝，不执行任何工具。
- **禁止自我回显**：不能通过桥调用桥自己注册的工具；`/tools` 也不回显它们。
- **令牌比较**用等长异或，避免时序泄露。
- **两个入口共用同一份 handler**，因此行为必然一致，不会出现「回环能用、局域网行为不同」。

## 测试

```powershell
# 纯逻辑（不需要 DSH）
node test/smoke.mjs
node test/client.mjs

# 真 HTTP 服务器端到端（不需要 DSH）
node test/e2e.mjs
node test/mcp.mjs
node test/lan.mjs

# 真实 DSH 运行时校验（需要 DSH 安装，不启动 DSH）
$env:ELECTRON_RUN_AS_NODE='1'
& $env:DSH_NODE_EXECUTABLE "test\host-load.mjs"
```

当前：**43 + 17 + 25 + 29 + 23 + 12 = 149 个用例全部通过**。

## 已知限制

- 仅完成 DSH 侧实现；手机侧 Kotlin 实现待做
  （但**推荐的 MCP 路径不需要手机侧写代码**，只需配置）
- 无协议版本协商（MCP 端点带 `protocolVersion`，自有端点只在 header 里带）
- 无基于 `request_id` 的服务端去重
- 无流式进度上报
- 会话 / 消息 / 文件传输不在本插件范围
- MCP 端点不提供 resources / prompts / 服务端推送
