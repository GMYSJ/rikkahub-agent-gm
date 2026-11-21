# 源码审计 / PROJECT AUDIT

> 阶段 0 产出。审计时间 2026-11-18。源码来源：`GMYSJ/rikkahub-agent-gm` master ZIP 快照。

## 一、项目概况

| 项 | 值 |
|---|---|
| 语言 | Kotlin |
| UI | Jetpack Compose |
| 构建 | Gradle + AGP `9.3.1` + Kotlin `2.4.10`（需 JDK 21） |
| 源码获取 | ZIP 快照（无 `.git`） |
| 仓库大小 | 44.4 MB（压缩） |

## 二、模块清单

```
:app          主应用（UI、工具、MCP、Shizuku、设置）
:ai           核心：Message/Provider/Tool 抽象
:workspace    手机本地 Linux 工作区（proot）
:web          Web 能力
:web-ui       独立 Web UI（TypeScript/React，pnpm 管理）
:common :document :material3 :highlight :search :speech
:local-llm :llama-cpp :videogen :oauth
:trace-cli
```

## 三、Agent 与工具架构（核心）

### Tool 抽象（`ai/src/main/java/me/rerere/ai/core/Tool.kt`）

```kotlin
@Serializable
data class Tool(
    val name: String,
    val description: String,
    val parameters: () -> InputSchema? = { null },
    val systemPrompt: (model: Model, messages: List<UIMessage>) -> String = { _, _ -> "" },
    val needsApproval: JsonElement -> Boolean = { false },
    val execute: suspend (JsonElement) -> List<UIMessagePart>
)
```

**关键评价**：
- `execute` 是 **suspend 函数**，天然支持异步与远程调用
- `needsApproval` 已是函数式，可按参数动态决定是否要用户批准 —— **适合承载远程工具的风险分级**
- `InputSchema` 只有 `Obj(properties, required)` 一种，**结构简单**，与 MCP 的 JSON Schema 可直接互转

→ **远程工具代理的实现切入点就是这里**：为远端工具构造一个 `Tool` 实例，`execute` 内部走 MCP/RPC 转发。

### 工具规模（`app/.../data/ai/tools/`）

约 **90+ 个工具实现**，覆盖：

| 类别 | 代表文件 |
|---|---|
| 文件 | `FileManagerTool` `FileBatchTools` `WriteFileTool` `ExternalStorageTools` `ArchiveTools` `DownloadTool` |
| 系统 | `BatteryTool` `VolumeTool` `BrightnessTool` `WifiInfoTool` `SensorTool` `TorchTool` `VibrateTool` |
| 屏幕交互 | `TapTool` `SwipeTool` `ScrollTool` `FindNodeTool` `WindowTreeTool` `ScreenshotTool` `GlobalActionTool` |
| 应用 | `AppLauncherTool` `SystemIntentTools` `ShareTool` `OpenFileTool` |
| 通讯 | `SmsInboxTool` `SmsSendTool` `CallLogTool` `ContactsTool` `NotificationTool` |
| 高级 | `ShizukuTool` `TermuxTool` `TermuxSessionTool` `SshTool` `SshSftpTool` `SshHostsTool` |
| 网络 | `WebFetchTool` `WebExtractTool` `BrowserTools` |
| 其它 | `CameraPhotoTool` `MicRecorderTool` `NfcTools` `KeystoreTools` `SpeechToTextTool` |
| 工具治理 | `ChatToolFactory` `ToolApprovalAllowList` `ToolApprovalDefaults` `ToolInvocationContext` |

→ **`ChatToolFactory` 是工具注册中心**，`ToolApprovalAllowList` / `ToolApprovalDefaults` 是权限体系，**远程代理必须复用它们，不能绕过**。

## 四、Provider / 模型架构

`ai/src/main/java/me/rerere/ai/provider/`：

- `Provider.kt` —— Provider 抽象
- `ProviderManager.kt` —— 管理器
- `ProviderSetting.kt` —— 配置
- `Model.kt` —— 模型描述
- 实现了 OpenAI Chat Completions / Responses、Claude、Google、Vertex、OpenRouter

→ **统一模型注册表的接入点**：`ProviderManager`。跨端模型需要包装成一个本地 `Provider`，请求转发到远端。

## 五、已有 MCP 支持（重大利好）

```
app/src/main/java/me/rerere/rikkahub/data/ai/mcp/
├── McpConfig.kt
├── McpManager.kt
├── McpOAuthCoordinator.kt
├── McpOAuthDiscoveryClient.kt
├── McpSessionRegistry.kt
├── McpStatus.kt
└── control/
    ├── McpApprovalRenderer.kt
    ├── McpControlTools.kt
    ├── McpControlValidation.kt
    ├── McpHeaderRedactor.kt
    └── McpUrlGuard.kt
```

**结论**：MCP 客户端已完整实现，含 OAuth、会话管理、审批渲染、URL 守卫、头脱敏。
**双向桥的新增工作量主要在「手机端做 MCP Server」这一侧，客户端侧可直接复用。**

依赖已声明：`io.modelcontextprotocol:kotlin-sdk-client` `0.15.0`。

## 六、Workspace 模块

```
workspace/src/main/java/me/rerere/workspace/
├── Workspace.kt
├── WorkspaceManager.kt
├── WorkspaceFileSystem.kt
├── WorkspaceShellRunner.kt
├── ProotShellRunner.kt
├── RootfsInstaller.kt
├── RootfsPatcher.kt
└── WorkspaceBackgroundProcesses.kt
```

**特点**：基于 proot 的 Linux 用户态，有独立 rootfs、Shell Runner、后台进程管理。
→ 电脑访问手机 Workspace 时，目标就是这个目录树，走 `WorkspaceFileSystem`。

## 七、Shizuku 模块

```
app/src/main/java/me/rerere/rikkahub/shizuku/
├── ShizukuManager.kt
├── ShizukuCommandRunner.kt
├── ShizukuUserService.kt
├── ShizukuStatus.kt
└── (aidl) IShizukuUserService.aidl
```

→ 通过 AIDL 绑定 UserService 执行 shell。**远程代理时必须保留其授权流程**。

## 八、现有 CI

`.github/workflows/build-android.yml` 已存在且质量高：

- `runs-on: ubuntu-latest`
- **`setup-java` 已用 JDK 21**（`distribution: jetbrains`）✅
- Bun + pnpm 10 + Node 24（用于 `web-ui` 构建）
- Gradle wrapper
- **固定签名**：keystore 不存在时自动生成并 commit 回仓库，保证版本可覆盖安装
- 产物：`:app:assembleRelease`，仅 arm64-v8a，R8 优化
- 上传 artifact：`RikkaHub-run<N>-arm64`

**结论**：CI 基建完善，本项目只需在其基础上扩展（如加测试、加 Windows 兼容产物），**不要推倒重写**。

## 九、技术栈版本

| 库 | 版本 |
|---|---|
| AGP | 9.3.1 |
| Kotlin | 2.4.10 |
| Ktor | 3.5.2 |
| OkHttp | 5.5.0 |
| Retrofit | 3.0.0 |
| MCP SDK | 0.15.0 |
| Coroutines | 1.11.0 |
| kotlinx-datetime | 0.8.0 |

## 十、初步结论

### 可直接复用
- MCP 客户端全套（`McpManager` 等）
- MCP Kotlin SDK 依赖
- Ktor 全栈（含 SSE、JWT、CIO server）
- `Tool` 抽象与 `ChatToolFactory` 注册体系
- `ProviderManager` 模型管理体系
- Shizuku / Workspace 实现
- 现有 CI workflow

### 需要新增
- **手机端 MCP Server**（暴露手机工具给电脑）
- **DSH 侧 MCP 桥**（DSH 插件或伴生服务，双向）
- **统一模型注册表**（跨端模型聚合）
- **远程工具代理**（包装远端 Tool，走 `execute` 转发）
- **UI**：设备管理、连接配置、执行节点选择、跨端任务列表

### 受上游限制
- DSH 无官方 MCP Server 导出能力，需自行实现（通过插件注入 `ctx.tools`）
- dsh-mobile-app 0.2.1 的协议细节需进一步逆向

### 需桌面端配套改造
- DSH 插件形式的 MCP 桥
- 动态发现 DSH web 端口（当前是随机的）
