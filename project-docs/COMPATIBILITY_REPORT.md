# 兼容性报告 / COMPATIBILITY REPORT

> 阶段 0 产出。记录两端版本与接口的兼容边界。

## 一、版本矩阵

| 组件 | 版本 | 来源 | 状态 |
|---|---|---|---|
| DSH 宿主 | `0.2.2-rc.5` | 用户本机 | 运行中 |
| `@dsh-mobile-app/desktop-extension` | `0.2.1` | 用户本机 | 运行中 |
| RikkaHub Agent | master 快照 | 2026-11-18 下载 | 待编译 |
| Android App（dsh-mobile） | `0.2.1` | 用户手机已装 | 可用 |

## 二、DSH ↔ dsh-mobile-app 兼容性（实测）

### 2.1 已知正常

| 项 | 状态 |
|---|---|
| 设备配对 | ✅ 正常（1 台已配对） |
| 局域网 HTTPS | ✅ `https://192.168.1.3:3443` |
| cpolar 隧道 | ✅ state=ready |
| 会话列表/对话 | ✅ |
| 文件传输（单个） | ✅ |
| 客户端模块注入 | ✅ `/api/mobile-access/client-modules` 返回 20KB |

### 2.2 已知不兼容 ⚠️

| 问题 | 根因 | 影响 |
|---|---|---|
| **插件管理页空白** | `dsh-client-ui-plugin-manager` 在专用移动前端激活失败。插件代码注释写明这是为 `0.1.7-rc.2+` 写的，而宿主是 `0.2.2` | 手机上看不到插件列表 |
| **文件单选** | 代码中无 `multiple` 支持 | 不能批量上传 |
| **Tailscale Funnel 不可用** | funnel 进程起来连上即掉线，日志 0 字节 | 该通道不可用 |
| **`setup.json` 的 `upstreamOrigin` 会过期** | DSH 每次重启换端口 | 需动态发现 |

### 2.3 动态上游发现（重要）

代码确认：`loopbackTemplate(loaded, ctx.webServer.port)` 在 `apply()` 时**动态读取** `ctx.webServer.port`。

**结论**：`setup.json` 里的 `upstreamOrigin` 值不参与握手，实际用的是运行时端口。
**但**：`GET /api/mobile-access/remote/control` 返回的 `origin` 是可信来源，本项目应从这里读。

## 三、Android 构建兼容性

### 3.1 工具链要求

| 项 | 要求 | 本机 |
|---|---|---|
| JDK | **21**（AGP 9.3.1） | ❌ 无 |
| Android SDK | 需 compileSdk（见 build.gradle） | ❌ 无 |
| Gradle | wrapper（仓库自带 `gradlew`） | ❌ 无 JVM |
| Node | 24（构建 web-ui） | ✅ `v24.22.1` |
| pnpm | 10（CI 用） | ✅ `11.28.5`（向后兼容） |
| Bun | CI 用 | ❌ 无 |

**结论**：必须走 GitHub Actions。

### 3.2 现有 CI 已满足

`.github/workflows/build-android.yml`：
- `setup-java` 用 JDK 21 ✅
- 有 Bun / pnpm 10 / Node 24 ✅
- 固定签名 keystore 自动生成并 commit ✅
- 产物 `:app:assembleRelease` + arm64-v8a ✅

**可直接使用，无需重建。**

## 四、MCP 协议兼容性

| 项 | 版本 | 备注 |
|---|---|---|
| MCP Kotlin SDK | `0.15.0` | 仅 client；**server 需自行实现或用 Ktor** |
| Ktor | `3.5.2` | 有 `ktor-server-sse`、`ktor-server-auth-jwt` |
| DSH MCP | `@deepseek-ai/dsh-mcp-client` | DSH 侧有 client，**无 server** |

**关键缺口**：
- 手机侧做 MCP Server → 用 Ktor 实现
- DSH 侧做 MCP Server → 需写插件

## 五、证书与安全

| 项 | 现状 |
|---|---|
| 移动网关 CA | 自签，`~/.dsh/mobile-access/tls/ca.pem` |
| 证书校验 | 不可关闭（主提示词红线） |
| 配对 token | 256-bit，存 `devices.json` |

## 六、结论与建议

### 6.1 可直接复用
- dsh-mobile-app 的**配对、证书、局域网、cpolar** 四件套
- DSH 的 `dsh-mcp-client`
- RikkaHub 的 MCP 客户端、Tool 抽象、Provider 体系

### 6.2 需新建
- 手机侧 MCP Server（Ktor）
- DSH 侧 MCP Server（插件）
- 统一模型注册表
- 远程工具代理层

### 6.3 风险提示
- dsh-mobile-app 0.2.1 与 DSH 0.2.2 已有兼容裂缝，**本项目不应深度绑定它的前端**
- 建议只复用其**网络/认证层**，UI 完全用 RikkaHub 自建
