# 数据迁移 / DATA MIGRATION

> 阶段 1 产出。2026-11-19。
> 主提示词第五节「双向 Workspace 融合」与第十三节「阶段 2 建立安全开发环境」的交集。
> 核心原则：**宁可少迁移，不可迁移错。**

## 一、先明确：我们要保护什么

| 资产 | 位置 | 丢失后果 |
|---|---|---|
| RikkaHub 会话与消息 | 手机 app 私有数据库 | 🔴 用户的聊天历史，不可重建 |
| RikkaHub 模型配置（含 API Key） | 手机 DataStore | 🔴 用户要重新输一遍所有 key |
| RikkaHub Workspace 文件 | 手机 `context.filesDir/workspaces/<root>/files` | 🔴 用户的项目文件 |
| DSH 会话日志 | `~/.dsh/sessions/` | 🟠 重要 |
| DSH profile 配置 | `~/.dsh/profiles/desktop/` | 🟠 重要（含 13 个插件配置） |
| 移动网关配对凭据 | `~/.dsh/mobile-access/devices.json` | 🟠 要重新配对 |
| WorkBuddy 登录状态 | 插件私有目录 | 🟠 主提示词明确要求不得破坏 |

**第一原则：本项目不是一次「迁移」，而是一次「叠加」。**

主提示词说得很清楚：

> 原有模型配置不得丢失。
> 不得要求用户重新输入已有 API Key。
> 保留两端原生工具实现，不要为了统一接口而重复实现相同功能。

所以下面的方案，**默认全是「只增不减」**。

## 二、手机侧：改动的数据结构

### 2.1 会新增的数据

| 数据 | 存储位置 | 说明 |
|---|---|---|
| `RemoteNode` 列表 | 新增 DataStore 字段 | 节点地址、标签、token、启用状态 |
| 节点-工具绑定 | 同上 | 哪些工具从哪个节点来 |

**关键约束**：新增字段必须**可缺省反序列化**。

已核实 RikkaHub 的真实存储模型（`PreferencesStore.kt:244-280` 的 `persistSettings`
与 `:337-376` 的读取逻辑）：

**`Settings` 不是整体序列化成一个 blob**，而是**每个字段各自映射到一个
`stringPreferencesKey`**：

```kotlin
// 写入（persistSettings）
preferences[DYNAMIC_COLOR]     = settings.dynamicColor
preferences[TITLE_PROMPT]      = settings.titlePrompt
preferences[CUSTOM_THEMES]     = JsonInstant.encodeToString(settings.customThemes)
preferences[PROVIDERS]         = ...   // 独立的 key

// 读取（settingsFlowRaw）
titlePrompt = preferences[TITLE_PROMPT] ?: DEFAULT_TITLE_PROMPT,
favoriteModels = preferences[FAVORITE_MODELS]?.let { raw ->
    runCatching { JsonInstant.decodeFromString<List<Uuid>>(raw) }.getOrElse { emptyList() }
} ?: emptyList(),
```

**这对迁移是个大利好**：新增字段只要在读取处写 `?: 默认值`，
老数据里没有这个 key 时会自动落到默认值，**不需要任何迁移脚本**。

反过来，删字段也是安全的（老的 key 变成孤儿，不影响读取）。

```kotlin
// ✅ 正确：新增字段 + 读取处给默认值
@Serializable
data class Settings(
    val remoteNodes: List<RemoteNode> = emptyList(),
)
// 读取处
remoteNodes = preferences[REMOTE_NODES]?.let { raw ->
    runCatching { JsonInstant.decodeFromString<List<RemoteNode>>(raw) }.getOrElse { emptyList() }
} ?: emptyList(),
```

**注意 `JsonInstant` 的配置**（`utils/Json.kt:7-12`）：

```kotlin
val JsonInstant by lazy {
    Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }
}
```

`ignoreUnknownKeys = true` 意味着 JSON 内部结构变化也不会崩。
`encodeDefaults = true` 意味着默认值会被写出来 —— 导入导出时字段齐全。

**但有个反直觉的点**：因为 `encodeDefaults = true`，
新增字段一旦被写入就会持久化。如果用户装了新版又回退旧版，
旧版读取时会忽略那个 key（不认识的 key 在 DataStore 里只是没人读，不会报错），
**再回到新版时旧值还在**。这是好事。

### 2.2 会改动的读取路径

新增字段需要在 **3 处**同步：

| 位置 | 作用 |
|---|---|
| `persistSettings()`（`:244`） | 写入 |
| `settingsFlowRaw`（`:337`） | 读取 |
| `updateSettings()`（`:724` 附近） | 部分更新 |

### 2.2 不会改动的数据

| 数据 | 为什么不改 |
|---|---|
| `providers: List<ProviderSetting>` | 远端模型走 `providerOverwrite`（已核实生效），不动 Provider 结构 |
| `assistants` 的工具选项 | 只在 `LocalToolOption` 里**追加**，不动已有项 |
| 会话与消息 | 完全不碰 |
| MCP 配置 | 远端节点不走 MCP，两者并存 |

### 2.3 `LocalToolOption` 的兼容性

已核实 `LocalToolOption` 有一个**宽松反序列化**机制（`LocalTools.kt:209-212` 的注释）：

> Deserializes a `LocalToolOption` list leniently: any entry whose "type" this build
> no longer defines (for example an upstream-only tool such as `screen_time` that the
> fork removed) is dropped instead of aborting the whole decode.

**这对我们极其重要**：

- 新版（含远端工具的）导出的配置，在旧版里会**丢弃未知项**而不是崩溃 ✅
- 旧版的配置在新版里读取，未知项本来就没有 ✅

所以**追加**新选项是安全的，不需要版本迁移脚本。

**但反过来有个坑**：如果用户在旧版上打开、保存，
新加的远端工具选项会被**静默丢弃**。这不是 bug（是设计），但要有心理准备。

## 三、电脑侧：不碰现有配置

### 3.1 铁律清单

| 操作 | 允许？ | 说明 |
|---|---|---|
| 改 `~/.dsh/profiles/desktop/package.json` | ❌ | 用 `plugin_manager install_bundle` |
| 改 `cordis.patch.yml` 的已有行 | ⚠️ 谨慎 | 只 `- id:` 覆盖，且必须备份 |
| 往 `cordis.patch.yml` 加新行 | ✅ | **必须用 `- insert:`** |
| 改 `im-qqbot` 配置 | ⚠️ 极谨慎 | 只能 key 级替换（见下） |
| 碰 `app.asar` | ❌ | 红线 |
| `pnpm add/remove` 后不检查 bundles | ❌ | 会清空 `dsh.profile.bundles` |

### 3.2 `im-qqbot` 的特殊风险（已有前科）

这个插件的配置里有 `appId` / `appSecret`（真实凭据）。

**已踩过的坑**：qqbot 插件保存设置时会用 js-yaml **重写整个 `im-qqbot` 行并重排 key 顺序**。
曾因为「按行号截断尾部」把 `appId`/`appSecret` 截掉过一次。

**本项目的规定**：

1. 改任何内容前先备份：`cordis.patch.yml.bak-<时间戳>`
2. 只做 **key 级行内替换**，禁止整体重新序列化
3. 改完必须校验：keys 含 `appId`/`appSecret`，且其余行未动

### 3.3 桥插件的安装是「纯增量」

`win-bridge` 的 `cordis.patch.yml` **只有一行 `- insert:`**，不覆盖任何已有行。

这意味着：
- 卸载 = 删掉这一行，其它一切不受影响
- 安装失败 = 最多是多一行无效配置，不会破坏现有 13 个插件

## 四、Workspace 访问的边界

### 4.1 手机侧的目录分层

已核实 `WorkspaceManager` 的路径模型（`WorkspaceManager.kt:9-14`）：

```
baseDir/                          ← context.filesDir/workspaces
└── <root>/                       ← 名字，非 ID，[A-Za-z0-9._-]+
    ├── files/                    ← 用户可见的文件
    ├── linux/                    ← proot rootfs
    └── tmp/
```

**桥只应暴露 `files/`**。理由：
- `linux/` 是 rootfs，暴露它等于让远端能改 Linux 环境（提权风险）
- `tmp/` 是临时目录，没有持久价值

### 4.2 必须区分的四类路径

主提示词明确要求：

> 必须区分：Android 私有目录 / 共享存储 / 应用沙箱 / Shizuku 可访问目录 / RikkaHub 自身 Workspace。
> 不能假定所有 Android 路径都具有相同权限。

| 类别 | 访问方式 | 桥是否暴露 |
|---|---|---|
| RikkaHub Workspace（`files/`） | `WorkspaceFileSystem` | ✅ 默认暴露 |
| 应用沙箱（`context.filesDir` 其它部分） | 直接 File | ❌ 不暴露 |
| 共享存储（`/sdcard`） | `ExternalStorageTools` | ⚠️ 需用户显式授权 |
| Shizuku 可访问目录 | `ShizukuCommandRunner` | ⚠️ 需 Shizuku 授权 |

**红线**：桥的路径参数**只能是相对路径**，根由服务端固定。
绝不接受网络传来的绝对路径（见 `SECURITY_MODEL.md` 7.1）。

### 4.3 文件传输的设计要点

主提示词要求支持：多文件、目录、大文件、分块、断点续传、完整性校验、
进度、取消、同名冲突、变更冲突。

**v1 状态：全部未实现。**

设计方向（待实现）：

| 项 | 方案 |
|---|---|
| 分块 | `Content-Range` 风格，块大小 256 KiB |
| 断点续传 | 服务端记录已收块位图，客户端可查询 |
| 完整性 | 每块 + 整体 SHA-256 |
| 同名冲突 | 显式三选一：覆盖 / 跳过 / 重命名（**不自动决定**） |
| 变更冲突 | 记录 mtime+size，不一致就拒绝并提示 |

**为什么 v1 不做**：文件传输是最容易出数据事故的部分。
在没有充分测试前，宁可不提供，也不能提供一个会覆盖用户文件的半成品。

## 五、回滚方案

### 5.1 手机侧

| 场景 | 回滚方式 |
|---|---|
| 新配置导致崩溃 | 卸载新版本、装回旧 APK（同签名可覆盖） |
| 数据结构不兼容 | 应用内设置 → 清除数据（**会丢失会话**，最后手段） |
| 只想关掉远端功能 | 设置里禁用远端节点，**不需要卸载** |

**备份建议**：RikkaHub 有导出功能，改动前让用户先导出一份。
`D:\AAAdeepseek\工作区\repos\rikkahub-import` 就是一份 43.9 MB 的现成导出数据
（**注意：这是用户数据，不是源码，不得修改或编译**）。

### 5.2 电脑侧

| 场景 | 回滚方式 |
|---|---|
| 桥插件出问题 | `plugin_manager remove_bundle` 或禁用该 bundle |
| `cordis.patch.yml` 被改坏 | 从 `.bak-<时间戳>` 恢复（profile 里已有 20+ 份备份） |
| `package.json` 的 bundles 被清空 | 从 `package.json.bak-*` 恢复（已有 5 份） |
| DSH 起不来 | `schtasks /Run /TN "DSH静默重启"`；必要时从 `boot-capture/` 看启动日志 |

**每次改 profile 前必须备份**，这不是建议是规定。

## 六、AI 生成内容的处理

本项目的文档与代码里有大量 AI 生成内容。几个具体风险：

| 风险 | 处理 |
|---|---|
| 虚构的 API/字段 | 已通过「读源码核实」流程控制，文档里区分「已核实」与「待验证」 |
| 假的测试通过 | 测试必须可复现，`TEST_REPORT.md` 写了具体命令 |
| 过期结论 | `DECISIONS.md` 里 D-002 明确标注「已被 D-004 取代」，不删只作废 |

**本项目的自我约束**：任何结论要么有文件路径+行号，要么明确标为「待验证」。
不允许「大概是」「应该是」这种表述混进结论。

## 七、迁移检查清单（发布前必做）

### 7.1 手机侧

- [ ] 新增字段全部有默认值（`= emptyList()` 等）
- [ ] 旧版本导出的配置能在新版读取（未知项丢弃而非崩溃）
- [ ] 未新增 Provider 子类（除非确认 10 处改动全部完成）
- [ ] 未改动 `providers` 结构
- [ ] 原有会话、模型 key 全部保留
- [ ] 卸载后不留残余（前端服务、数据库表）

### 7.2 电脑侧

- [ ] `cordis.patch.yml` 新行用的是 `- insert:`
- [ ] 改动前已备份
- [ ] 13 个原有插件全部还在
- [ ] `dsh.profile.bundles` 完整且顺序未变
- [ ] WorkBuddy 登录状态未动
- [ ] `im-qqbot` 的 `appId`/`appSecret` 仍在
- [ ] 未触碰 `app.asar`

### 7.3 通用

- [ ] `leak_guard` 扫描通过（无 critical/high）
- [ ] 无硬编码端口
- [ ] 无硬编码 cpolar 域名
- [ ] 无关闭 TLS 校验的代码

## 八、待验证的假设

- [ ] `WorkspaceFileSystem` 能否安全地以 `files/` 为根构造实例
      （已核实它是实例方法、每个方法收 `root: File` 参数，但未实测以 `files/` 为根的行为）
- [ ] RikkaHub 的导出/导入格式（`ExportSerializer.kt`）是否覆盖新增的 `remoteNodes` 字段
- [ ] DSH 的 `plugin_manager remove_bundle` 是否完整回收插件注册的工具

### 已核实、不再是假设的项

- [x] `Settings` 是 `@Serializable data class`（`PreferencesStore.kt:831-832`）
- [x] **`Settings` 不整体序列化**，每字段独立 `stringPreferencesKey`
      （`persistSettings` `:244-280`、`settingsFlowRaw` `:337-376`）
- [x] 读取处普遍用 `?: 默认值` + `runCatching{}.getOrElse{}` → 新增字段天然向后兼容
- [x] `JsonInstant` 配了 `ignoreUnknownKeys = true` + `encodeDefaults = true`（`utils/Json.kt:7-12`）
- [x] `WorkspaceManager` 的目录模型：`baseDir/<root>/{files,linux,tmp}`（`:9-14`）
- [x] `WorkspaceFileSystem.resolvePath` 做 canonical + `startsWith(root+sep)` + 拒 NUL（`:234-251`）

## 九、现状

| 项 | 状态 |
|---|---|
| 手机侧数据模型设计 | 📄 本文档 |
| 手机侧实现 | ❌ 未开始 |
| 电脑侧桥插件安装 | ⚠️ 未安装（需 `install_bundle` + 重启） |
| 文件传输 | ❌ 未实现 |
| 回滚方案 | ✅ 已记录（profile 备份机制现成） |
