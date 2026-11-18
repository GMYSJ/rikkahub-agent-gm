# 测试报告 / TEST REPORT

> 每次测试执行后更新。测试必须可复现 —— 写清命令，不要只写结论。

## 当前总览

| 套件 | 用例 | 状态 |
|---|---|---|
| `test/smoke.mjs` | 43 | ✅ |
| `test/client.mjs` | 17 | ✅ |
| `test/e2e.mjs` | 25 | ✅ |
| `test/mcp.mjs` | 29 | ✅ |
| `test/lan.mjs` | 28 | ✅ |
| `test/host-load.mjs` | 12 | ✅ |
| **离线合计** | **154** | **全绿** |
| **真实 DSH 端到端** | **34 项**（回环 17 + 局域网 17） | **全绿** |

## 2026-11-19（第五轮）— 局域网监听

**背景**：DSH Desktop 的 webServer 只绑 `127.0.0.1`，手机在局域网里够不到。
`dsh-host-webserver` 又拒绝通配地址，所以只能另起独立监听。

### 离线测试：新增 `test/lan.mjs`（23 项）

**配置校验（13）**
- 合法配置通过
- **拒绝 `0.0.0.0` / `::` / `*`**（会把桥暴露到所有网卡）
- **拒绝 `127.x` / `localhost`**（绑回环等于没做）
- 拒绝非 IPv4 字面量、缺 host、端口越界/非整数
- **缺 token 被拒、token 太短被拒**（局域网必须鉴权）

**真实监听（10）**
- 监听成功、`/health` 可用、`/tools` 列出工具、`/tools/call` 真执行
- **MCP 端点也可用**（复用同一 handler）
- **跳数防护照样生效**（508）
- handler 抛异常不崩监听（返回 500）
- `close()` 能释放端口、端口占用时明确失败、绑定不存在地址时明确失败

### 真实 DSH 局域网验证（17 项）

| # | 项目 | 结果 |
|---|---|---|
| 1 | 监听地址 | ✅ `192.168.1.3:61420`，**未绑 0.0.0.0** |
| 2 | `/health` | ✅ 200，`authRequired: true` |
| 3 | 无 token `/tools` | ✅ 401 |
| 4 | 带 LAN token `/tools` | ✅ **29 个工具** |
| 5 | **主 token 在 LAN 端口** | ✅ **401（凭据隔离生效）** |
| 6 | LAN MCP `initialize` | ✅ `dsh-mobile-bridge v0.1.0` |
| 7 | LAN MCP `notifications/initialized` | ✅ 202 空正文 |
| 8 | LAN MCP `tools/list` | ✅ 29 个 |
| 9 | LAN MCP `tools/call` 真执行 | ✅ 返回记忆库内容 |
| 10-14 | 连续 5 次 ping | ✅ 5/5 |
| 15 | LAN 跳数防护 | ✅ 508 |
| 16 | LAN `mcp__` 前缀拦截 | ✅ 403 |
| 17 | 回归检查 | ✅ 见下 |

### 回归检查发现的问题

装桥时 `install_bundle` 的 pnpm 改写了 `package.json`，
把 `dsh-go-workspace` 从 `dsh.profile.bundles` 去掉了。

**追查**：对比 `package.json.bak-*` 系列备份，确认它在 `bak-bridge-20261119-002539`
（00:25:39）里还在，之后消失。

**判断：不恢复。** 依据：
- 用户明确说「换了这个新插件，原来那个弃用了」
- 本次会话**第一次核查时 3443 就已不监听**（说明早已停用）
- 两者同脉网关、抢 3443 与 `mobile-access`，旧包明写不可并存

其余回归项全部正常：`im-qqbot` 的 `appId`/`appSecret` 仍在，其余插件完好。

### 复现命令

```powershell
# 局域网可达性
Invoke-RestMethod "http://192.168.1.3:61420/dsh-mobile-bridge/health"

# 带令牌列工具
$patch = Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Encoding UTF8 -Raw
$lan = [regex]::Match($patch, "lan:\s*\r?\n\s*host:\s*'[^']+'\s*\r?\n\s*port:\s*\d+\s*\r?\n\s*token:\s*'([0-9a-f]{64})'").Groups[1].Value
Invoke-RestMethod "http://192.168.1.3:61420/dsh-mobile-bridge/tools" -Headers @{ Authorization = "Bearer $lan" }
```

### 未验证

- [ ] **真实 Android 手机**（需要你在手机上配 MCP，本机无 adb）
- [ ] 跨网段 / 经路由器的连通性（只在同一 WLAN 内验证）
- [ ] TLS（当前局域网是明文 HTTP，仅靠 token）


## 2026-11-19（第四轮）— 真实 DSH 环境端到端验证

**这是第一次在真实运行中的 DSH 上验证，此前全部是脱宿主测试。**

### 环境

| 项 | 值 |
|---|---|
| DSH | `0.2.2-rc.5`，重启后端口 `61412` |
| 安装方式 | `plugin_manager install_bundle`，`application: applied` |
| 插件路径 | `node_modules/dsh-mobile-bridge` → Junction → 工作区 `win-bridge` |
| 鉴权 | 64 字符随机 token，仅存 profile `cordis.patch.yml`，不进 git |

### 17 项实测结果

| # | 项目 | 预期 | 实际 |
|---|---|---|---|
| 1 | `/health` 探活 | 200 | ✅ `{"ok":true,"protocolVersion":1,"nodeId":"windows-dsh","authRequired":true}` |
| 2 | 无 token 访问 `/tools` | 401 | ✅ 401 |
| 3 | 带 token 访问 `/tools` | 200 + 工具清单 | ✅ **18 个工具**，真的从 `ctx.tools` 读到 |
| 4 | MCP `initialize` | 版本与 capabilities | ✅ `dsh-mobile-bridge v0.1.0` / `2025-06-18` |
| 5 | MCP `notifications/initialized` | 202 空正文 | ✅ 202，长度 0 |
| 6 | MCP `tools/list` | 工具数组 | ✅ 18 个，`inputSchema.type=object` |
| 7 | MCP `tools/call` 执行 `memory_list` | 真实返回 | ✅ **真的执行了**，返回记忆库内容 |
| 8 | 原生 `/tools/call` 执行同一工具 | 成功 | ✅ `ok=True` |
| 9 | 跳数达上限 | 508 | ✅ 508 hop_limit |
| 10 | 调 `mcp__` 前缀工具 | 403 | ✅ 403 forbidden |
| 11 | 错误 token | 401 | ✅ 401 |
| 12 | `/tools` 不含 `mcp__` 工具 | 无 | ✅ 无 |
| 13 | 反向注册工具 | accepted | ✅ 2 个 accepted |
| 14 | `/nodes` 可见 | 列出节点 | ✅ `phone-sim` 工具数 2 |
| 15 | 注册后仍不自我回显 | 仍 18 个 | ✅ 仍 18 |
| 16 | **跨节点真实回调** | 拿到远端数据 | ✅ **`{"battery":87,"detail":true}`** |
| 17 | 全端点清单 | 6 个都活 | ✅ health/tools/nodes/tools/call/register/mcp 全 200 或预期码 |

### 第 16 项是最重要的一条

这是**完整双向闭环**的证明：

```
真实 DSH 的模型/工具面
    ↓ ctx.tools.execute()
桥的 Tool.execute()
    ↓ callRemoteTool()
POST http://127.0.0.1:65512/phone-bridge/tools/call   ← 假手机节点
    ↓ 返回 {battery:87}
桥旋转结果
    ↓
MCP tools/call 返回 {"battery":87,"detail":true}
```

**测试中发现的真实缺陷**：第一次用 `baseUrl` 指向桥自己时，回调失败
（`unknown tool "sim_battery"`）——因为桥回调过去用的是**原始工具名**，
而自己没注册过这个名字。这不是 bug，是测试设计错了；改用真实的两个节点后立刻通过。

它反过来说明一个正确性：桥记住的是 **`(nodeSlug, 原始工具名)`** 而非限定名，
所以远端节点只需实现自己的 `/tools/call` 即可，不需要知道 `mcp__` 前缀规则。

### 回归检查（确认没破坏已有功能）

| 项 | 结果 |
|---|---|
| 原有 15 个 bundles | ✅ 一个不少，现 16 个 |
| `im-qqbot` 的 `appId`/`appSecret` | ✅ 未动（L302/L303） |
| WorkBuddy 插件文件时间戳 | ✅ 11/18 21:38，未变 |
| 三个内置 `@deepseek-ai/*` 包 | ✅ 从 DSH 安装目录解析，不在 profile node_modules（正常） |

### 复现命令

> ⚠️ **找端口别猜。** DSH 会listen 多个回环端口（webServer + 内部服务），
> 桥只挂在 webServer 上。用 `-and $_.LocalAddress -eq '127.0.0.1'` 筛出来的可能不止一个，
> 必须**探 `/dsh-mobile-bridge/health`** 才准。踩过一次：误把内部服务端口当成桥，
> 结果 403。

```powershell
# 逐个探测，找出桥真正在哪个端口
$procs = Get-Process 'DeepSeek Harness'
$ports = Get-NetTCPConnection -State Listen |
  Where-Object { $_.OwningProcess -in $procs.Id -and $_.LocalAddress -eq '127.0.0.1' } |
  Select-Object -ExpandProperty LocalPort | Sort-Object -Unique

foreach ($p in $ports) {
  try {
    $r = Invoke-RestMethod "http://127.0.0.1:$p/dsh-mobile-bridge/health" -TimeoutSec 3 -ErrorAction Stop
    if ($r.ok) { Write-Host "桥在 $p"; $port = $p; break }
  } catch { }   # 非桥端口会 404/403，忽略
}

# 从 profile 的 patch 里读出桥的 Bearer 令牌（只在本机读，不要提交/回显明文）
$patch = Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Encoding UTF8 -Raw
$token = [regex]::Match($patch, "token:\s*'([0-9a-f]{64})'").Groups[1].Value
$h = @{ Authorization = "Bearer $token"; 'content-type' = 'application/json' }

Invoke-RestMethod "http://127.0.0.1:$port/dsh-mobile-bridge/tools" -Headers $h
```

> 注：`token` 只存在于 profile 的 `cordis.patch.yml`，不进入本仓库。
> 本报告只记录"令牌长度 64"，不记录任何真实值。

### 未验证（诚实清单）

- [ ] **真实 Android 手机**接入（本机无 adb，无可用调试通道）
- [ ] 跨局域网 / cpolar 隧道的连通性（只在 loopback 验证过）
- [ ] 手机侧 `McpManager` 对真实 MCP 端点的兼容（已按 `StreamableHttpClientTransport` 语义实现，但未用真机验证）
- [ ] 并发压力与长时间运行
- [ ] 真实模型的完整 Agent 回合（只验证了工具单次调用）


## 2026-11-19（第三轮）— MCP 兼容端点

### 新增 `test/mcp.mjs`（29 用例）

**纯函数（11）**：`rpcResult` / `rpcError` 形状、`undefined` 转 `{}`、
`toMcpTool` 保留 object 根 schema、非 object 根兜底、
`parseToolCallParams` 正常/缺 name/arguments 非对象、
`toMcpCallResult` 成功搬运 text 块 / 无 text 块用 value 兜底 / 失败带 isError。

**协议分支（9）**：`initialize` 返回版本与 capabilities、
`notifications/initialized` 不响应、`ping`、`tools/list`、
`tools/call`、缺 name 给 INVALID_PARAMS、未知方法给 METHOD_NOT_FOUND、
非 2.0 被拒、**工具抛异常返回 isError 而非协议错误**。

**HTTP 端到端（9）**：真服务器 + 真 fetch
- `initialize` 成功
- `notifications/initialized` 返回 202 空正文（MCP 规范要求）
- `tools/list` 列出 DSH 工具
- `tools/call` **真的执行了工具**（断言调用计数 +1）
- 批量请求返回数组
- 坏 JSON 返回 PARSE_ERROR 且状态 200（JSON-RPC 层错误不改变 HTTP 状态）
- `GET /mcp` 返回 405（不提供推送流）
- **MCP 工具清单不含 `mcp__` 前缀工具**（防自我回显，与原生端点一致）
- **MCP 端点也受跳数预算保护**（508）

### 本轮重构验证

抽出 `executeTool()` 后重跑全部套件，确认**无回归**：
原生 `/tools/call` 与 MCP `/tools/call` 走同一条
`ctx.tools.execute()` 路径，都不可绕过审批。

## 2026-11-19（第二轮）— 阶段 1 文档的事实核查

本轮没有新增代码，但**对文档里每个关键断言做了源码/安装包核实**，
把「待验证假设」逐条转成「已核实」或明确标注仍未知。

### 核实结果

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | `Settings` 是否整体序列化（决定迁移方案） | ❌ 否，**逐字段独立 key** | `PreferencesStore.kt:244-280` 写入、`:337-376` 读取 |
| 2 | 新增字段是否需要迁移脚本 | ❌ 不需要（读取处 `?: 默认值`） | 同上 |
| 3 | `JsonInstant` 是否容忍未知键 | ✅ `ignoreUnknownKeys=true` | `utils/Json.kt:7-12` |
| 4 | `providerOverwrite` 是否真正生效 | ✅ 被 11 处调用，默认生效 | `GenerationLoop.kt:506` 等 |
| 5 | `providerOverwrite` 有无例外 | ⚠️ 有：列表分组用 `checkOverwrite=false` | `ModelList.kt:335` |
| 6 | 桥端点是否与现有 `/api` 冲突 | ❌ 不冲突，`route("/api")` 只占该前缀 | `WebApiModule.kt:140-141` |
| 7 | 桥能否复用现有 JWT 鉴权 | ✅ 有 `authenticate("auth-jwt")` 分支 | `WebApiModule.kt:170-186` |
| 8 | 工具白名单能否复用 `LocalToolOption` | ✅ 是 sealed class + 50 多个开关 | `LocalTools.kt:132-207` |
| 9 | `NO_ALWAYS_ALLOW` 精确项数 | ✅ **10 项**（脚本逐行枚举） | `ToolApprovalDefaults.kt:262-293` |
| 10 | `WorkspaceFileSystem` 能否以 `files/` 为根 | ✅ 实例方法、每调用收 `root` | `WorkspaceFileSystem.kt:12-35` |
| 11 | `Tool` 是否有 `systemPrompt` | ✅ 有（早期文档漏记） | `Tool.kt:12-19` |
| 12 | `Provider` 流式方法名 | ✅ `streamText` 返回 `Flow<StreamChunk>` | `Provider.kt:29-33` |
| 13 | `getProviderByType` 分派方式 | ✅ 穷尽 `when`，9 种 `ProviderSetting` | `ProviderManager.kt:51-64` |
| 14 | DSH 是否提供 OpenAI 兼容端点 | ❌ **不提供**（上轮结论有误，已纠正） | 全仓 `/v1/models` 仅出站发现代码 |

### 本轮纠正的错误

**上一轮的错误结论**：「电脑是 OpenAI 兼容端点，手机侧加个 baseUrl 即可，零代码。」

**实际**：DSH 不对外提供 `POST /v1/chat/completions`。
`dsh-llm-pi-ai/src/discovery.ts:121-131` 里的 `/v1/models` 是**出站**去问上游厂商的
客户端代码。所以这层门面必须由桥自己实现。

**教训**：搜到字符串不等于找到了端点。要看**方向**（出站还是监听）。

### 核实方法（可复现）

```powershell
# 代码事实：用 grep 工具按文件搜，读上下文行号
# 安装包事实：用 DSH 自带 Electron-as-Node 遍历 asar
$env:ELECTRON_RUN_AS_NODE='1'
& $env:DSH_NODE_EXECUTABLE "D:\AAAdeepseek\工作区\.tmp\rg-asar.js" "pattern1" "pattern2"

# 精确计数（不靠肉眼）：
# 用循环按行匹配 setOf("...") 内的字符串字面量
```

### 仍然未知（诚实清单）

- [ ] `ctx.llm.stream()` 分片能否无损映射成 OpenAI SSE
- [ ] DSH `ToolSchema` ↔ OpenAI `tools` 转换的信息损失
- [ ] 手机 `OpenAIProvider` 遇非标准 SSE 的行为
- [ ] `workbuddy` 这类走插件认证的 provider 经桥转发是否正常
- [ ] 跨模型代理时远端工具调用的前缀规则
- [ ] `plugin_manager remove_bundle` 是否完整回收工具注册

这些必须在实现阶段实测，**不能靠推理就当结论用**。

---

## 2026-11-19（第一轮）— win-bridge 插件（DSH 侧双向工具桥）

### 环境

| 项 | 值 |
|---|---|
| 宿主 | Windows 11 IoT LTSC 26200 |
| DSH | `0.2.2-rc.5` |
| 运行时 | DSH 自带 Electron-as-Node（`$env:DSH_NODE_EXECUTABLE`） |
| 工作目录 | `win-bridge/` |

### 结果总览

| 套件 | 用例 | 通过 | 失败 | 是否需要 DSH |
|---|---|---|---|---|
| `test/smoke.mjs` | 43 | 43 | 0 | 否 |
| `test/client.mjs` | 17 | 17 | 0 | 否 |
| `test/e2e.mjs` | 25 | 25 | 0 | 否（真 HTTP 服务器） |
| `test/host-load.mjs` | 12 | 12 | 0 | 需 DSH 安装（不启动 DSH） |
| **合计** | **97** | **97** | **0** | — |

### 复现命令

```powershell
cd D:\AAAdeepseek\工作区\repos\rikkahub-agent-gm\win-bridge

node test/smoke.mjs
node test/client.mjs
node test/e2e.mjs

$env:ELECTRON_RUN_AS_NODE='1'
& $env:DSH_NODE_EXECUTABLE "test\host-load.mjs"
```

### 各套件覆盖内容

**smoke（43）** — 纯逻辑
- trace header 解析：大小写不敏感、数组取值、缺失降级、非法值降级、null 不崩
- 循环防护：跳数 0 放行、达上限拒绝、超限拒绝、每次转发 +1、连续两次后拒绝
- 信封：成功/失败格式、`undefined` 转 null、空 details 不出现
- wire 工具校验：合法通过、缺 name / 空 name / 超长 / parameters 非对象均拒绝、name 被 trim
- 工具名限定：加前缀可逆、非法字符清洗、不合约返回 null、前缀是 `mcp__`
- Schema 出方向：标量直通、`required` 搬到父级、子 schema 不留 required、嵌套递归、array items、`type:json` 退化、enum 保留
- Schema 入方向：父级数组还原、非必填不带 required、复杂关键字识别（含嵌套）、lossy 标记、简单无损
- 往返一致性：spec → JSON Schema → spec 保类型与必填

**client（17）** — 出站调用（假 fetch）
- 成功路径：返回 value、请求体含 tool/arguments、header 带 trace 且跳数 +1、token 才带 Authorization、尾部斜杠处理
- 失败路径：远端 `ok:false` 透传错误码、非 JSON 给 internal、网络异常给 tool_failed、超时给 timeout、上游取消给 cancelled、已取消立即生效、无 fetch 明确报错
- 拉取清单：校验与 rejected 分离、对端报错透传、缺 tools 返回空数组、网络失败不抛

**e2e（25）** — **真 HTTP 服务器，两个桥互调**
- 健康检查与工具清单：`/health`、`/tools`、参数已转标准 JSON Schema（required 在父级）
- 出方向执行：真的执行了工具、失败投影成 `ok:false`、未知工具不崩、缺 tool 400、坏 JSON 400 不 500、未知路径 404
- 循环防护：跳数达上限 508、**被拒时工具根本没执行**（断言调用计数未增）、不能调自己注册的远端工具（403）
- 入方向：注册返回 accepted、注册后**真的能被 DSH 执行并回调到手机**、`/nodes` 可见、缺 baseUrl 拒绝、非 http(s) 拒绝、非法工具进 rejected 不影响合法项、重复注册不报错
- 鉴权：无令牌 401、错令牌 401、对令牌放行、`/health` 不要令牌
- 默认关闭：`enabled` 不为 true 时一个端点都不挂

**host-load（12）** — **真实 DSH 运行时**
- 模块可加载：`name`/`inject`/`apply` 导出、三个子模块独立加载
- 真实 `@deepseek-ai/dsh-tools` 从安装锚点解析成功
- 真实 `defineTool` 校验我们转换后的参数能通过
- `required` 编译到父级数组（入参字段级 → 出参父级数组）
- 复杂 schema 退回空 spec 后仍能注册
- **包裹结构会被真实 defineTool 拒绝**（记录踩过的坑，防止回归）
- 缺 `output` 被拒绝（证明用的是真实实现）

### 本轮发现并修复的真实缺陷

| # | 问题 | 严重度 | 修复 |
|---|---|---|---|
| 1 | `parameters` 传 `{type:'object',properties}` 包裹结构会被真实 `defineTool` 拒绝，**所有远端工具注册都会失败** | 🔴 高 | 改为返回逐字段映射（`schema.ts:450` 的语义） |
| 2 | 入方向工具 `execute` 是占位抛错，注册了却不可用 | 🔴 高 | 改为真实回调远端节点（`client.js` 的 `callRemoteTool`） |
| 3 | 测试里 `MockTools.register` 被重复定义，后一个覆盖前一个 | 🟡 中 | 拆成 `register`（真注册）与 `add`（便利写法） |

第 1 项是**只有跑真实宿主才能发现**的问题 —— 纯 mock 测试全部通过，因为它只校验了形状。
这也是 `host-load.mjs` 这个套件存在的理由。

### 未覆盖（诚实清单）

- 手机侧 Kotlin 实现（未开始）
- 跨真实局域网/隧道的连通性（需要一个真实环境，本阶段只验证到 localhost）
- 并发压力与资源泄漏（未做长时间运行测试）
- 协议版本协商（未实现）
- 真实模型调用远端工具的端到端（需要装进 profile 并重启 DSH，属下一步）

---

## 历史

### 2026-11-18

阶段 0 审计阶段，无代码测试。以源码审读与文档产出为主。
