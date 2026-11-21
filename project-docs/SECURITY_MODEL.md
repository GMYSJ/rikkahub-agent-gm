# 安全模型 / SECURITY MODEL

> 阶段 1 产出。2026-11-19。
> 主提示词第十五节有 17 条工程质量要求，其中多条是安全红线（尤其第 11、12 条）。
> 本文只写**已核实**的机制与**明确承认**的缺口，不写漂亮话。

## 一、威胁模型

先明确敌人在哪，否则安全措施都是空的。

| 威胁 | 现实性 | 说明 |
|---|---|---|
| **局域网内其他设备** | 🔴 高 | 同一个 Wi-Fi 下的任何设备都能扫到开放端口 |
| **公网扫描** | 🔴 高 | cpolar / 隧道暴露后会被人扫 |
| **手机丢失** | 🟠 中 | 手机上的配对凭据与模型 key |
| **电脑被他人使用** | 🟠 中 | 同一台电脑的其他账户 |
| **恶意插件** | 🟡 中低 | 本项目自己的桥插件若被改坏 |
| **远端节点被攻陷** | 🟠 中 | 手机被控 → 反向调用电脑工具 |
| **中间人** | 🟡 中低 | 未加密的桥流量 |

**不在威胁模型内**：
- 有权在电脑本机执行任意代码的攻击者（那时一切都完了）
- DSH 宿主本身的漏洞（不在本项目控制范围）

## 二、分层防御

```
第 1 层：网络可达性     —— 默认关闭，不开启就无端点
第 2 层：传输加密       —— HTTPS（复用现有自签 CA / 隧道）
第 3 层：身份认证       —— 桥 token（Bearer）
第 4 层：工具审批       —— DSH 流水线 + RikkaHub mcp__ 前缀规则
第 5 层：执行沙箱       —— DSH 的沙箱与 HardlineCommandGuard
第 6 层：循环与重放防护 —— 跳数预算、自我回显禁止
```

**纵深防御原则**：任一层被绕过，下一层仍然挡得住。所以**不允许**为了「方便」删掉任何一层。

## 三、第 1 层：默认关闭

`win-bridge/cordis.patch.yml` 里：

```yaml
- insert:
    - id: plugin-mobile-bridge
      name: 'dsh-mobile-bridge'
      config:
        enabled: false      # ← 默认关闭
```

**理由**：装上一个插件，不应该等于在局域网上开一个口子。
默认安全的代价只是多改一个配置项；默认开放的代价可能不可逆。

有测试覆盖：`enabled` 不为 `true` 时**一个端点都不挂**（`e2e.mjs` 最后一条用例）。

## 四、第 2 层：传输加密

### 4.1 现状

| 通道 | 加密 | 说明 |
|---|---|---|
| 局域网 | HTTPS | 现有自签 CA（`~/.dsh/mobile-access/tls/ca.pem`），手机侧固定指纹 |
| cpolar | HTTPS | 公网 CA |
| 桥单独端口 | — | **不另开端口**，复用 DSH 的 webServer |

**关键设计**：桥挂在 `ctx.webServer` 上，因此**直接继承 DSH 的监听地址与协议**。
DSH Desktop 绑 `127.0.0.1`（回环，外部不可达），需要外网时由移动网关反代。

### 4.2 红线：不允许关闭证书校验

主提示词明令：

> 证书校验不能简单关闭来解决连接问题。
> 不允许通过关闭 TLS 校验解决证书问题。

**这条对本项目是硬约束**。遇到证书问题时的正确做法：

1. 检查 CA 指纹是否匹配（`/mobile-access/ca.cer`）
2. 检查证书是否过期
3. **重新配对**获得新指纹

**错误做法**（明令禁止）：`trustAllCerts`、`HostnameVerifier` 返回 true、忽略 `SSLException`。

### 4.3 已知限制

DSH 的 `dsh-host-webserver` **本身不做认证**，README 原文：

> 绑定非回环地址仍会向该网络公开未受保护的 route 与静态资源。

所以**把 DSH 直接绑到 `0.0.0.0` 是危险的**，而且实际上也做不到 ——
通配地址在 Schema 层就被拒绝（`webserver/src/index.ts:362-364`）：

> `binding every interface would expose remote code execution to the network; bind one concrete IPv4 or IPv6 address instead`

**结论**：外网访问必须走移动网关（反代 + 设备配对），不能靠直接绑网卡。

## 五、第 3 层：桥的鉴权

### 5.1 机制

```yaml
config:
  token: '<一个足够长的随机串>'   # 可选，设置后启用鉴权
```

- 除 `/health` 外所有端点要求 `Authorization: Bearer <token>`
- 比较用**等长逐字节异或**：

```js
if (given.length !== token.length) return { ok: false, reason: 'invalid token' };
let diff = 0;
for (let i = 0; i < given.length; i += 1) diff |= given.charCodeAt(i) ^ token.charCodeAt(i);
return diff === 0 ? { ok: true } : { ok: false, reason: 'invalid token' };
```

**为什么这么写**：
- 长度不等**立刻**拒绝 → 避免逐字符比较泄露长度
- 等长时**不短路** → 比较耗时与第一个不同字符的位置无关，不泄露前缀

这是防时序侧信道的最低要求。用 `===` 比较字符串在严格意义上是可被计时的。

`/health` 不要求鉴权是**故意的**：它只返回协议版本与节点名，不含任何敏感信息，
但能让运维快速判断「端点是否活着」。有测试覆盖这个设计（`e2e.mjs`）。

### 5.2 现状缺口（诚实）

- `token` 未设置时，桥**没有任何鉴权**，仅依赖网络可达性
- 这与 DSH 自身 webServer 不做认证的现状一致，是**有意的取舍**
- **生产使用必须设置 token**，或用移动网关的设备配对层兜住

### 5.3 未来方向

桥 token 应与现有设备配对身份绑定（复用 `~/.dsh/mobile-access/devices.json`
的配对凭据），而不是一个静态共享串。属阶段 4。

## 六、第 4 层：工具审批（最关键的一层）

### 6.1 DSH 侧：桥不是审批旁路

桥执行工具走：

```js
await ctx.tools.execute({ calls: [...], signal });
```

走这个入口，DSH 的完整流水线照常生效：

```
tools/pre-execute → guards → tools/execute → tools/post-execute → finalizeContent
```

包括 `HardlineCommandGuard`（审批前的硬底线，Always Allow / YOLO 都**不能**覆盖）。

**错误做法**（本插件明确不做）：直接调 `definition.execute()`。
那等于给远程调用开一条绕过全部守卫的后门，正是主提示词禁止的
「工具权限被远程调用绕过」。

有测试覆盖：`e2e.mjs` 验证工具失败走 DSH 的失败投影而非裸抛。

### 6.2 手机侧：`mcp__` 前缀继承审批

`ToolApprovalDefaults.kt:304-305`：

```kotlin
fun requiresApproval(toolName: String): Boolean =
    toolName in ALWAYS_ASK || toolName.startsWith("mcp__")
```

源码注释（`:297-303`）说明意图：

> MCP-relayed tools (`mcp__*`) are always gated because the MCP server's tool
> surface is opaque to us — we can't know which calls are destructive.

**远端节点的工具面比 MCP server 更不可知**，所以这条规则不仅适用，而且更必要。

因此远端工具名强制：

```
mcp__<nodeSlug>__<原始工具名>
```

**收益**：不需要改 `ToolApprovalDefaults`，不需要改 `HardlineCommandGuard.kt:185`，
自动继承既有保护。**改命名规则 = 两处漏改 = 安全漏洞**，所以这条写进 `DECISIONS.md`（D-005）。

### 6.3 硬底线工具清单

`ToolApprovalDefaults.NO_ALWAYS_ALLOW`（`:262-293`）里的工具，
**永远不能**通过「Always Allow」跳过审批。已逐条核实，**共 10 项**：

| # | 工具 | 为什么必须每次都批 |
|---|---|---|
| 1 | `mcp_add` | 加一个恶意 MCP server 等于把助手工具集能碰到的东西全泄漏出去 |
| 2 | `mcp_update` | 同上 |
| 3 | `eval_javascript` | 在 QuickJS 里跑任意代码，是「无人值守下的常驻任意代码原语」 |
| 4 | `skill_install_from_url` | 从任意 URL 拉 skill 内容并装进工具面 |
| 5 | `skill_install_from_text` | 同上，来源是原始文本 |
| 6 | `browser_eval_js` | 在真实 WebView 里跑 JS，**带着用户的 cookie 与已认证 fetch** |
| 7 | `keystore_generate_key` | 生成后续 sign/encrypt 都信任的硬件密钥 |
| 8 | `keystore_decrypt` | 把密文解成明文给模型读 |
| 9 | `nfc_write_tag` | 永久改写物理标签内容 |
| 10 | `grant_directory_access` | 对整棵存储树持久读写，可能是云盘 / Downloads / Pictures |

（与源码 `setOf(...)` 一一对应，共 **10 个字符串**，位于 `ToolApprovalDefaults.kt:262-293`。
已用脚本逐行枚举核对，不是估算。）

这些工具即使被桥暴露，每调用一次都要用户当场批准。**不提供远程绕过路径。**

源码注释里还有一句值得记住的设计原则（`:256-261`）：

> adding an MCP server is exactly that, since a hostile server can exfiltrate
> anything reachable through the assistant's tool set.

**这对远端节点完全适用** —— 一个被控制的手机节点，能拿到助手工具集能碰到的一切。
这正是本桥默认关闭、且远端工具一律走审批的根本原因。

## 七、第 5 层：执行边界

### 7.1 文件路径

**红线：桥绝不接受网络传来的绝对路径直接使用。**

```kotlin
// ❌ 危险：完全绕过逃逸校验
File(networkPath).readText()

// ✅ 正确：走 WorkspaceFileSystem，根来自 WorkspaceManager
workspaceFileSystem.readText(relativePath)   // 内部做 canonical + startsWith 校验
```

`WorkspaceFileSystem.resolvePath`（`:234-251`）做了三件事：

1. `canonical` 归一化（消解 `..` 与符号链接）
2. `startsWith(rootPath + sep)` 校验（防逃逸出根）
3. 拒绝含 NUL 的路径（`:241`）

绕过它等于把整个手机/电脑文件系统交出去。

### 7.2 Shizuku

**不绕过授权流程**。Shizuku 是用户显式授权的能力，
远程调用时：

- 授权状态由手机本地决定，电脑无法代为授权
- `ShizukuCommandRunner` 的 AIDL 绑定流程必须完整走
- 未授权时明确报错，**不静默降级到 root 或 shell**

### 7.3 沙箱

DSH 侧工具有自己的沙箱策略（`dsh-sandbox-policy`）。
桥**不改变**当前会话的沙箱权限，工具按宿主配置的权限运行。

**当前会话是 `danger-full-access`** —— 这是用户的选择，桥不放大也不缩小它。

## 八、第 6 层：循环与重放

### 8.1 循环防护（已实现并测试）

```
每次跨端转发：hop_count += 1
入站检查：hop_count >= 2 → 508 拒绝
```

**关键**：拒绝发生在**执行任何工具之前**。有测试断言被拒时工具调用计数未增加 ——
否则「拒绝」只是返回了个错误码，工具照样跑了。

### 8.2 自我回显防护（已实现并测试）

1. `mcp__` 前缀的工具**不出现在** `/tools` 清单里 → 远端不会看到自己注册的工具
2. 不能经 `/tools/call` 调用 `mcp__` 前缀工具 → 403

否则 A 注册给 B，B 又把它列给 A，A 再调 B… 无限套娃。

### 8.3 重放防护（**未实现**）

v1 只**透传** `x-dsh-request-id`，**不做服务端去重**。

意味着：如果调用方因超时重试，同一个请求可能被执行两次。

**缓解**：调用方应保证不重放；或为幂等性敏感的工具单独设计。

**这是已知缺口，不是遗漏**，属阶段 4（需要服务端状态表 + TTL）。

## 九、凭据管理

### 9.1 三类凭据必须分清

| 凭据 | 归属 | 是否过桥 | 泄露后果 |
|---|---|---|---|
| 桥 token | 用户配置 | — | 攻击者能用你的电脑工具与模型额度 |
| 设备配对凭据 | `devices.json` | — | 同上，且可长期访问 |
| 上游厂商 API Key | 各节点本地 | **绝不过桥** | 攻击者能用你的账号额度并产生费用 |

**设计原则：模型 key 永不跨端复制。**

- 手机模型给电脑用 → 电脑只发消息，手机自己拿 key 调上游
- 电脑模型给手机用 → 手机只拿桥 token，拿不到任何厂商 key

这满足主提示词「避免不必要地复制 API Key」与「不得将密钥暴露给不需要它的另一端」。

### 9.2 日志与输出

**不得写入日志**：API key、token、配对凭据、私钥。

**本项目的落实**：
- 桥的 `logger.info` 只输出挂载路径与节点名，**不输出 token**
- 错误消息不拼接 token
- 发布前用 `leak_guard` 扫描（本地、脱敏）

已执行：

```
leak_guard scan win-bridge/     → 12 文件 / 101 KB，0 发现，干净
leak_guard scan project-docs/   → 12 文件 / 66 KB，0 发现，干净
```

### 9.3 WorkBuddy 凭据

主提示词明确：Engine 期间只按现有授权继续工作，**不得**输出 token 明文，
**不得**主动吊销或清理凭据。

本项目对它的处理：**只读使用，不落盘，不进 Git，不进日志**。

## 十、资源与拒绝服务

| 资源 | 上限 | 实现 |
|---|---|---|
| 请求体 | 512 KiB | 超限立刻 `destroy`，**不读完再判断** |
| 单次注册工具数 | 200 | 防注册表被刷爆 |
| 工具执行超时 | 默认 120 s / 上限 600 s | `AbortController` |
| 工具名长度 | 128 | 与 DSH 约束对齐 |

**「不读完再判断」为什么重要**：如果先收完再检查大小，攻击者可以用无限流把你撑爆。
超限时立刻 `req.destroy()` 是唯一正确做法。

## 十一、已实现 vs 未实现（诚实清单）

### ✅ 已实现并有测试

- 默认关闭，不开启无端点
- Bearer token 鉴权（等长异或比较）
- 跳数预算循环防护（拒绝时不执行工具）
- 自我回显禁止（清单过滤 + 调用拦截）
- 请求体上限 + 立刻断开
- 工具执行走 `ctx.tools.execute()`（不绕审批）
- 远端工具名强制 `mcp__` 前缀（继承审批）
- 失败抛异常而非静默成功
- 节点离线时明确报错
- 发布前凭据扫描

### ❌ 未实现（已知缺口）

| 缺口 | 影响 | 计划 |
|---|---|---|
| 桥 token 未与设备配对绑定 | 静态共享串，泄露后需手动更换 | 阶段 4 |
| 无请求去重 | 重试可能重复执行 | 阶段 4 |
| 无速率限制 | 被控节点可高频打爆本机 | 阶段 4 |
| 无审计日志持久化 | 事后难追溯 | 阶段 4 |
| 手机侧实现未开始 | 上述部分机制尚无手机侧对应物 | 下一步 |
| 无 mTLS | 仅 Bearer token | 视需要 |

## 十二、安全相关的产品决策

有几条不能只写在文档里，得写进代码约定：

1. **远端工具必须带 `mcp__` 前缀** —— 见 `DECISIONS.md` D-005
2. **插件默认 `enabled: false`** —— 见 D-006
3. **工具执行必须走 `ctx.tools.execute()`** —— 见 D-007

这三条改动任何一个，都要重新评估整个安全模型。
