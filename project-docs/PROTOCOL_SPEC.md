# 跨端协议规格 / PROTOCOL SPEC

> 阶段 1 产出。版本 **v1**。
> 本文件描述 RikkaHub（手机）与 DSH（电脑）之间的桥接协议。
> 实现：`win-bridge/lib/protocol.js`、`win-bridge/lib/client.js`、`win-bridge/lib/index.js`
> 测试：`win-bridge/test/`（126 个用例）

## 一、先说结论：为什么不是 MCP

原架构文档（`ARCHITECTURE.md` 2.1 节）假定「两端都用 MCP，DSH 侧用 MCP Server 暴露工具」。
**这个前提经实测证伪，必须修正。**

### 1.1 实测证据

| 结论 | 证据 |
|---|---|
| DSH 只有 MCP **客户端** | `@deepseek-ai/dsh-mcp-client` 只 import `@modelcontextprotocol/client`（`src/transport.ts:9-11`） |
| 运行时**没有** MCP 服务端包 | `node_modules/@modelcontextprotocol/` 下只有 `client` 与 `core`，**`server` / `node` / `sdk` 不存在** |
| 全仓无自建 MCP Server | 无 `createMcpServer` / `serveMcp` / `dsh-mcp-server`；唯一 `McpServer` 类型来自 `@agentclientprotocol/sdk` 的**入参**类型 |
| mcp-client 只能「进」不能「出」 | 它把外部 server 的工具注册进 `ctx.tools`，但从不把 `ctx.tools` 暴露出去 |

**所以「让 DSH 当 MCP Server」这条路不存在**，除非自己额外写一个独立进程再反向调 DSH —— 那只是多一层还有一份 owner 凭据的转包（详见 1.3）。

### 1.2 DSH 真正有的是什么

DSH 有一套完整的 **Typert Remote** RPC：
- 一元：`POST /api/<ns>/<method>`
- 流与事件：单条 `WebSocket /api/remote.mux`
- 认证：进程启动令牌 → 签名 Cookie → Peer；非 owner 需 `dsh-api-remote-access` 的 policy

它很强，但有两个硬约束让它**不适合直接给手机用**：

1. **`/connect` 换出来的 Cookie 就是完整 owner 权限**，没有细粒度降权
   （`dsh-client-connection/src/rpc-host.ts:169-173` 固定 `principal: { kind: 'owner' }`）；
2. 协议是**类型化且随版本漂移**的内部约定，不是对外契约。

### 1.3 选型对比

| 方案 | 可行性 | 结论 |
|---|---|---|
| 反代 DSH Web GUI（现有 `dsh-mobile-app` 做法） | ⭐⭐⭐⭐⭐ | 已可用，但对「融合进 RikkaHub 原生 UI」没有帮助，且只是把整页塞给 WebView |
| 自建 MCP Server 包一层 DSH | ⭐ | ❌ **不成立**：MCP 服务端能力不存在 |
| 独立 MCP Server 进程 + 反调 DSH `/api` | ⚠️ | 绕远：多一层进程、多一份 owner 凭据、多一跳延迟，只在「已有别家 MCP 客户端」时才值 |
| **自制极简 HTTP 桥（本方案）** | ⭐⭐⭐⭐⭐ | ✅ **选它**：协议小到可完整测试、两端实现必然对称、可版本化、可逐条加固 |

### 1.4 本方案的边界（诚实说明）

- 本协议**不试图复刻** DSH 的全部能力。它只做两件事：**暴露工具清单与执行**、**接收远端工具注册**。
- 会话列表、消息收发、文件传输、模型代理**不在 v1 范围**，另有规划（见 `MODEL_ROUTING.md` 后续阶段）。
- 拿它与 owner RPC 比能力，是错误比较；v1 只提供**工具面**的最小可用闭环。

## 二、传输与端点

桥挂在 DSH 自己的 `ctx.webServer` 上，因此**自动继承 DSH 的端口，不需要硬编码、也不需要端口发现**。
这是本方案相对「另起一个服务」的关键优势 —— 直接规避了 `setup.json` 的 `upstreamOrigin` 过期问题。

默认前缀 `<base>` = `/dsh-mobile-bridge`，可配置。

| 方法 | 路径 | 用途 | 需鉴权 |
|---|---|---|---|
| `GET` | `<base>/health` | 探活，返回协议版本与节点标识 | 否 |
| `GET` | `<base>/tools` | 列出本节点可调用工具（标准 JSON Schema） | 是 |
| `POST` | `<base>/tools/call` | 执行一个工具 | 是 |
| `POST` | `<base>/register` | 远端注册自己的工具（含回调地址） | 是 |
| `GET` | `<base>/nodes` | 查看已注册的远端节点（排障用） | 是 |
| `POST` | `<base>/mcp` | **MCP Streamable HTTP 兼容端点** | 是 |

**两个方向用同一套端点**，因为两端实现同一个插件 —— 这在 e2e 测试里被直接验证（电脑和手机各起一个桥，互相对调）。

### 2.1 为什么同时提供 MCP 端点（重要）

第 1.1 节说过「DSH 不能当 MCP Server」，那是指**没有现成的服务端实现可用**。
但我们**可以自己写一个最小的** —— 而这件事非常值得做，理由是：

> **RikkaHub 侧已经有完整的 MCP 客户端。**
> `McpSessionRegistry.kt:466-478` 明确支持 `SseClientTransport` 与
> `StreamableHttpClientTransport`。

所以在桥这边讲 MCP，手机侧就是**一行配置、零代码**：

```
RikkaHub → 设置 → MCP → 添加服务器
  transport: streamable-http
  url:       https://<电脑>:<port>/dsh-mobile-bridge/mcp
  headers:   Authorization: Bearer <token>
（然后务必在 Assistant → MCP 里勾选该 server）
```

这比让手机实现本桥的私有协议省得多。**私有协议仍然保留**，用于
`/register` 这种 MCP 表达不了的反向注册，以及更细粒度的排障端点。

### 2.2 MCP 端点的实现范围

`lib/mcp.js` 是一个 SDK 无关的纯逻辑实现（约 250 行），只做够用的事：

| MCP 方法 | 行为 |
|---|---|
| `initialize` | 返回 `protocolVersion: "2025-06-18"`、`capabilities.tools`、`serverInfo` |
| `notifications/initialized` | 不响应（HTTP 202 空正文） |
| `notifications/cancelled` | 不响应 |
| `ping` | 返回 `{}` |
| `tools/list` | 把 DSH 工具转成 MCP `{name, description, inputSchema}` |
| `tools/call` | 走 `executeTool()` → `ctx.tools.execute()`（**不绕审批**） |

**不实现**：resources、prompts、sampling、roots、progress、服务端推送流
（`GET /mcp` 返回 405）。请求这些会得到 JSON-RPC `-32601 Method not found`。

**批量请求**支持（JSON-RPC 数组），返回数组。

**错误语义**（容易做错的地方）：

- 工具执行失败 → 返回 `result.isError = true`，**不是** JSON-RPC error
  （否则客户端会以为协议坏了）
- 工具内部抛异常 → 同上，也归为 `isError`
- 参数不合法 → JSON-RPC `-32602`
- 方法不存在 → JSON-RPC `-32601`

## 三、请求头

| Header | 必填 | 说明 |
|---|---|---|
| `x-dsh-protocol` | 否 | 协议版本，当前 `1`。缺失按 `1` 处理 |
| `x-dsh-trace-id` | 否 | 一次用户请求共用同一 trace。缺失记 `untraced` |
| `x-dsh-hop-count` | 否 | 已跨端跳数。**安全关键**，缺失按 `0` |
| `x-dsh-source-node` | 否 | 发起方节点标识 |
| `x-dsh-target-node` | 否 | 目标节点标识 |
| `x-dsh-request-id` | 否 | 单次请求 id，用于去重 |
| `authorization` | 视配置 | `Bearer <token>`，仅当桥配置了 `token` |

**设计取向**：除鉴权外，所有追踪元数据缺失都**降级而不报错** —— 追踪信息不该成为拒绝一次正常工具调用的理由。唯一例外是跳数超限（见 4.1）。

## 四、安全边界

### 4.1 防止工具循环调用

跨端工具代理最危险的不是性能，是 **A→B→A 无限循环**。

```
每次向外转发：hop_count += 1
入站检查：hop_count >= 2  →  直接 508 拒绝，不执行任何工具
```

- 常量：`MAX_HOP_COUNT = 2`（`protocol.js`）
- 拒绝时返回 HTTP `508`，`error.code = "hop_limit"`
- **在被拒之前不会执行任何工具**（有专门测试断言工具调用计数未增加）

为什么是 2 而不是更大：一次正常的「手机→电脑」是 1 跳；「手机→电脑→手机」已经构成回环，第 3 跳没有合法业务场景存在。

### 4.2 禁止自我回显

`POST <base>/tools/call` 若 `tool` 名以 `mcp__` 开头，直接 `403 forbidden`。
原因：桥自己注册的远端工具名就是这个前缀，允许调用等于让请求绕回自己。

同时 `GET <base>/tools` 会**过滤掉**所有 `mcp__` 前缀工具，不把远端的工具原样回显给远端。

### 4.3 工具名前缀与审批继承

远端工具一律命名为：

```
mcp__<nodeSlug>__<原始工具名>
```

这不是美化，是**安全机制**。RikkaHub 的审批体系里：

```kotlin
// ToolApprovalDefaults.kt:304-305
requiresApproval = name in ALWAYS_ASK || name.startsWith("mcp__")
```

即 `mcp__` 前缀的工具**默认要求人工批准**。用这个前缀，远端工具就自动继承了这条保护，而不是绕过它。

### 4.4 鉴权

- 桥默认 **`enabled: false`**，不显式打开就一个端点都不挂（有测试覆盖）。
- 可选 `token`：设置后所有端点（除 `/health`）要求 `Authorization: Bearer <token>`。
- 比较用**等长逐字节异或**，避免逐字符短路泄露长度/前缀信息。
- `token` 未设置时视为「已在可信网络内」—— 与 DSH 自身 webServer 不做认证的现状一致，真正的边界由外层（局域网 TLS / 隧道）提供。**这是有意的取舍，不是遗漏。**

### 4.5 资源限制

| 项 | 上限 | 理由 |
|---|---|---|
| 请求体 | 512 KiB | 防止一次灌爆内存；超限立刻 `destroy` 而非读完再判断 |
| 单次注册工具数 | 200 | 防止注册表被刷爆 |
| 工具执行超时 | 默认 120 s，上限 600 s | 防止悬挂 |
| 工具名长度 | 128 | 与 DSH 命名约束对齐 |

## 五、数据结构

### 5.1 工具描述（wire）

```jsonc
{
  "name": "shell_exec",              // 必填，非空，≤128 字符
  "description": "执行命令",          // 可选，缺失按空串
  "parameters": {                    // 可选，标准 JSON Schema（object 根）
    "type": "object",
    "properties": { "command": { "type": "string" } },
    "required": ["command"]
  }
}
```

### 5.2 统一信封

成功：
```json
{ "ok": true, "result": <任意 JSON> }
```

失败：
```json
{ "ok": false, "error": { "code": "tool_failed", "message": "...", "details": { } } }
```

`details` 只在有内容时出现，不留空对象。

### 5.3 错误码

| code | 含义 |
|---|---|
| `bad_request` | 请求不合法（JSON 坏了、缺字段） |
| `unauthorized` | 鉴权失败 |
| `forbidden` | 越权（如调用自己注册的远端工具） |
| `not_found` | 端点不存在 |
| `tool_not_found` | 工具不存在 |
| `tool_failed` | 工具执行失败 |
| `timeout` | 超时 |
| `cancelled` | 被取消 |
| `hop_limit` | 跳数超限（循环防护） |
| `version_mismatch` | 协议版本不兼容 |
| `payload_too_large` | 请求体超限 |
| `internal` | 其他内部错误 |

## 六、端点细节

### 6.1 `GET <base>/tools`

```jsonc
{
  "ok": true,
  "result": {
    "protocolVersion": 1,
    "nodeId": "windows-dsh",
    "tools": [ /* 见 5.1 */ ]
  }
}
```

只取 `ctx.tools.definitions()` 的**全局视图**（不传 scope）：桥是部署级能力，不是某个 agent 的私产。
产出前会把 `parameters` 从 DSH 的字段映射形式转成标准 JSON Schema（见第七节）。

### 6.2 `POST <base>/tools/call`

请求：
```jsonc
{ "tool": "shell_exec", "arguments": { "command": "echo hi" } }
```

执行走 **`ctx.tools.execute({ calls: [...], signal })`** —— 这是关键选择：

> 桥**不是审批旁路**。因为走的是 DSH 自己的执行入口，
> `tools/pre-execute` → guards → `tools/execute` → `tools/post-execute` 整条流水线照常生效，
> 包括 `HardlineCommandGuard` 和用户审批。

响应：
```jsonc
{
  "ok": true,
  "traceId": "...",
  "result": <工具返回值>,
  "content": [ /* DSH ContentBlock[] */ ]
}
```

失败时 `ok:false`，`error.code` 取自 DSH 自己的失败码或本协议错误码。

**取消语义**：调用方断开连接时，`res.on('close')` 立刻 `abort`，不留下后台瞎跑的工具。

### 6.3 `POST <base>/register`

请求：
```jsonc
{
  "node": "phone",
  "baseUrl": "https://192.168.1.5:8443/phone-bridge",
  "token": "可选",
  "tools": [ /* 见 5.1 */ ]
}
```

- `baseUrl` **必填**且必须是绝对 http(s) URL。理由：注册进来的工具在执行时要回调到这个地址。没有它就注册 = 注册一堆永远执行失败的工具，比不注册更糟。
- 返回 `accepted` / `rejected` 两个数组：一个坏工具不会拖垮整批。
- **同名重注册先撤旧的**，否则 DSH 注册表会因冲突整批回滚。
- 注册成功记入 `remoteNodes`，工具执行时用它来找到回调地址与令牌。

响应：
```jsonc
{ "ok": true, "result": { "node": "phone", "accepted": [{ "name": "mcp__phone__get_battery", "lossy": false }], "rejected": [] } }
```

### 6.4 入方向工具的执行

注册进来的工具，其 `execute` 会在被模型调用时：

1. 查 `remoteNodes` 拿到 `baseUrl` 与 `token`；
2. 用 `callRemoteTool()` 发 `POST <baseUrl>/tools/call`，**跳数 +1**；
3. 成功返回 `value`，失败**抛异常**。

失败为什么抛异常而不是返回错误值：让 DSH 的失败流水线接管，保住「失败结果带结构化错误」的语义，而不是伪装成一次成功的工具调用。

## 七、JSON Schema 转换（最容易出错的地方）

这是**实测踩到的真实坑**，记录在此避免重犯。

### 7.1 DSH 的 `parameters` 是字段映射，不是包裹结构

```js
// ✅ 正确：逐字段映射
parameters: {
  detail: { type: 'boolean', required: true }
}

// ❌ 错误：会被 defineTool 拒绝
parameters: {
  type: 'object',
  properties: { detail: { type: 'boolean' } }
}
```

传错形式会报：`JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object`
（`dsh-tools/src/schema.ts:450` 的 `parameterSchemaSpecToJsonSchema` 走 `compilePropertyMap`，
把 `type` 当成一个叫「type」的**字段**去编译，于是失败。）

### 7.2 `required` 的位置在两个方向上相反

| 方向 | `required` 在哪 |
|---|---|
| DSH spec（入参） | 每个字段自己的 `required: true` |
| 标准 JSON Schema（wire） | 父级的 `required: string[]` |
| `defineTool` 编译后（出参） | 又回到父级 `required: string[]` |

**两侧都要做这一次搬移**，任一侧漏做，模型侧就会把必填参数当可选，调用必然失败。

### 7.3 有损转换的显式标记

DSH 的 spec 只支持 `string`/`number`/`integer`/`boolean`/`null`/`array`/`object`/`oneOf`。
遇到 `$ref`、`allOf`、`anyOf`、`not`、`if/then/else`、多分支 `oneOf` 时，**无法无损表达**。

处理方式：整份退回空 spec，并在结果里标 `lossy: true`。
**不强行降级** —— 悄悄放宽或收紧参数约束，比不做转换更危险。

## 八、版本兼容

- 协议版本是**整数常量** `PROTOCOL_VERSION = 1`。
- 不兼容改动必须递增版本号，并在两端做显式协商（v1 尚未实现协商，仅预留字段）。
- 出站 header 恒带 `x-dsh-protocol`，便于对端提前判断。

## 九、实测覆盖

| 套件 | 用例数 | 覆盖 |
|---|---|---|
| `test/smoke.mjs` | 43 | 协议解析、循环防护、信封、工具名限定、Schema 双向转换、往返一致性 |
| `test/client.mjs` | 17 | 出站调用、header 构造、超时/取消/网络错误、工具清单拉取 |
| `test/e2e.mjs` | 25 | **真 HTTP 服务器**：两端各起一个桥互调、鉴权、跳数拒绝、注册与回调 |
| `test/host-load.mjs` | 12 | **真实 DSH 运行时**：模块加载、真实 `defineTool` 校验、required 编译 |
| `test/mcp.mjs` | 29 | **MCP 端点**：纯函数、协议分支、HTTP 端到端、批量、鉴权与跳数 |

合计 **126 个用例**，全部通过。

## 十、v1 未做的事（诚实清单）

- [ ] 自有协议的版本**协商**（只在 header 里带，未做拒绝逻辑）
- [ ] 基于 `request_id` 的**服务端去重**（目前只透传）
- [ ] 工具的**流式进度**上报
- [ ] MCP 的 resources / prompts / sampling / 服务端推送流
- [ ] 会话、消息、文件传输（另有规划）
- [ ] 细粒度 principal / 权限降级（v1 靠 `mcp__` 前缀继承 RikkaHub 审批）
- [ ] 手机侧 Kotlin 实现
      （**但 MCP 路径不需要手机侧写代码**，配置即可）
