# 阻塞项 / BLOCKERS

> 遇到无法自行解决的问题记在这里，含：现象 / 已尝试 / 需要用户做什么。

## 未解决

### B-1 源码无 Git 历史（降级，不阻塞开发）

**现象**：本机无 `git`，源码以 ZIP 方式获取（`codeload.github.com/.../master`），已解压到项目根目录，**但没有 `.git` 目录**。

**影响**：
- 无法 `git diff` / `git log` / 创建分支 / 直接 push
- 改动无法版本化追溯

**缓解**：开发期间用文件级备份（`*.bak-时间戳`）代替版本控制。最终交付前再解决。

**需要用户**：暂不需要。若后期需要 push 代码，再决定装 Git 或用网页端。

---

### B-2 无本地 Android 编译链

**现象**：`java` / `adb` / `gradle` 均无，`JAVA_HOME` / `ANDROID_HOME` 为空，包管理器（winget/scoop/choco）也没有。

**影响**：无法本地编译、无法本地安装测试。

**既定方案**：走 GitHub Actions 云端构建（JDK 21）。本地只做源码修改与静态审查。

**需要用户**：无（已定方案）。

---

### B-3 无可用 ADB 通道

**现象**：设备管理器列出 6 个 `Android ADB Interface`，状态均为 `Unknown`。

**影响**：无法确认手机是否可调试，无法实机安装测试。

**需要用户**：若需实机验证，需插手机并开启 USB 调试（或提供无线调试配对方式）。

---

### B-4 未解决的移动端 UI 限制（继承自 dsh-mobile-app 0.2.1）

**现象**：
- 移动前端插件管理页显示"没有可管理的插件"（`dsh-client-ui-plugin-manager` 在专用移动前端激活失败）
- 文件选择只能单个添加，无 `multiple`

**影响**：本项目若复用其前端逻辑，需自行修复这两处。

**需要用户**：无。属兼容性分析范围，不强制复制缺陷。

---

## 已解决

### ✅ B-0 源码获取（原 B-1）

**原问题**：本机无 git，无法 `git clone`。

**解决方式**：改用 `https://codeload.github.com/GMYSJ/rikkahub-agent-gm/zip/refs/heads/master` 直接下载 ZIP（44.4 MB），Python/PowerShell 均可，30 秒完成。已解压落位。

**结论**：无 git 不阻塞源码获取，只影响版本控制。
