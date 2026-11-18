# 环境审计 / ENVIRONMENT REPORT

> 阶段 0 产出。采集时间 2026-11-18。运行前须重新核实。

## 硬件与系统

| 项 | 值 |
|---|---|
| 主机名 | `DESKTOP-NL1ST1` → 实际 `DESKTOP-NLRS1T1` |
| 系统 | Windows 11 IoT Enterprise LTSC `10.0.26200` 64-bit |
| CPU | AMD Ryzen 9 7945HX |
| RAM | 15.7 GB |
| PowerShell | 5.1.26100.6899（**非 Core，读 UTF-8 须加 `-Encoding UTF8`**） |

## 运行时

| 项 | 值 |
|---|---|
| Node | `v24.22.1` |
| npm | `11.19.1` |
| pnpm | `11.28.5`（DSH 自带，勿与 npm 混淆） |
| Python | `D:\Python311\python.exe` |
| DSH_HOME | `C:\Users\刘家强\.dsh` |

## DSH 宿主

| 项 | 值 |
|---|---|
| 版本 | `0.2.2-rc.5` / ProductVersion `0.2.2.0` |
| 安装目录 | `D:\AAAdeepseek\Harness` |
| 可执行 | `D:\AAAdeepseek\Harness\DeepSeek Harness.exe` |
| 活动 Profile | `desktop` |
| Profile 路径 | `C:\Users\刘家强\.dsh\profiles\desktop` |
| patchReload | `live` |
| 其他 Profile | desktop-backup-20261024-233755 / headless / web / web-backup-20261024-233256 |

## 已安装插件（13 个 + 2 个 link）

```
@240xu/dsh-session-search          0.1.11
@dsh-mobile-app/desktop-extension  0.2.1
@tencent-connect/dsh-qqbot         0.5.5
@zzerx/dsh-plugin-memory           0.4.4
dsh-api-dashboard                  1.7.2
dsh-connect-workbuddy              5.24.15
dsh-dim-text                       link
dsh-hutao-router                   link
dsh-forget-session                 2.2.1
dsh-leak-guard                     0.1.1
dsh-plugin-wallpaper-engine        1.4.2
dsh-skin-market                    0.1.83
dsh-whalechan-herself              ^0.4.0
```

## 工具链现状（关键）

| 工具 | 状态 |
|---|---|
| java | ❌ 未安装 |
| adb | ❌ 未安装 |
| gradle | ❌ 未安装 |
| git | ❌ 未安装 |
| winget / scoop / choco | ❌ 均无 |
| JAVA_HOME / ANDROID_HOME | 空 |
| **Android NDK r28** | ✅ 有（`pd2243-work\ndk\android-ndk-r28-win\android-ndk-r28`），仅 C/C++ |

**结论**：本地无法构建 Kotlin/Compose 工程，必须走 GitHub Actions（JDK 21）。

## 网络

| 网卡 | IP |
|---|---|
| WLAN | `192.168.1.3/24` |
| Tailscale | `100.91.212.5/32` |
| EasyTier | `10.126.126.1/24` |

## 移动端网关

| 项 | 值 |
|---|---|
| 局域网 | `https://192.168.1.3:3443` |
| 上游 | DSH web 端口（**每次重启会变，须动态发现**） |
| 远程 | cpolar，**域名动态读取，禁止硬编码** |

## RikkaHub 源码构建要求（来自 libs.versions.toml）

| 项 | 版本 |
|---|---|
| AGP | `9.3.1`（**须 JDK 21**） |
| Kotlin | `2.4.10` |
| Ktor | `3.5.2` |
| OkHttp | `5.5.0` |
| Retrofit | `3.0.0` |
| MCP SDK | `io.modelcontextprotocol:kotlin-sdk-client` `0.15.0` |

## 已知问题

- 移动前端插件管理页空白（`dsh-client-ui-plugin-manager` 激活失败）
- 文件选择不支持多选
- Tailscale Funnel 不可用
