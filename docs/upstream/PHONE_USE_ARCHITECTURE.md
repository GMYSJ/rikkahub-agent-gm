# Phone Use 与 GMYSJ 设备自动化：架构对照

> 对应 `CONFLICTS.md` C-03。这是最高风险区，**在统一调度层落地前 Phone Use 不进稳定分支**。
> 本文档是 `FEATURE_MATRIX.md` 中 Phone Use（P0）项的前置设计材料。
> 依据：`official/master` 源码 + 主体 `HEAD` 源码逐项比对。

---

## 1. 结论先行

| 判断 | 结论 |
|---|---|
| 两者关系 | **平行实现，不是上下游关系** |
| 能否直接叠加 | ❌ **不能**。两边各注册一个独立 `AccessibilityService`，会同时抢屏幕 |
| 本质冲突 | 操作系统层面**只允许一个无障碍服务实例真正驱动交互** —— 实际上可以并存两个 service，但**同一时刻对同一窗口的注入会互相打断**，且用户要授权两次 |
| 复用可能性 | ✅ **高**。两边能力几乎一一对应，主体侧实现更完整（含截图、节点树、日志环） |
| 建议 | 以 **GMYSJ 设备执行器为唯一底层**，Phone Use 只作为「工具层 + UI 层」接入，复用同一 `AccessibilityService` |

---

## 2. 能力对照表

| 能力 | 官方 Phone Use | 主体 GMYSJ | 差异 / 处理 |
|---|---|---|---|
| 无障碍 Service | `PhoneUseAccessibilityService`（`app/src/github/`） | `RikkaAccessibilityService`（`app/src/main/`） | **两个独立 service，必须合并为一个** |
| Service 配置 | `res/xml/phone_use_accessibility.xml` | `res/xml/accessibility_service_config.xml` | 合并配置，取能力并集 |
| 控制器 | `PhoneController`（`phoneuse/PhoneController.kt`） | `AccessibilityServiceHandle.kt` | 主体为 handle 模式，官方为 controller 模式，需适配层 |
| 屏幕截图 | `captureScreen()` / `screenshot(maxSide)` | `captureScreenshot(displayId)` → `ScreenshotOutcome` | 主体已支持 displayId，官方限主屏 |
| 屏幕元素 | `PhoneElement`（index/label/resourceId/bounds/clickable/editable/scrollable/checked/focused） | `traverseTree(...)`（含 maxDepth=60、truncated 标记、节点回收） | 元素模型需统一；主体遍历更谨慎（深度限制 + 回收） |
| 点击 | `gesture(fromX, fromY, toX, toY, durationMs)` | `buildTapPath` + `dispatchGestureAsync` | 官方统一为 gesture；主体有异步回调 |
| 滑动 | 同上（同 gesture，不同起终点） | `buildSwipePath` | 同上 |
| 输入文本 | `setText(elementIndex, text)` | 主体经 `KeyboardTools` / 节点 `ACTION_SET_TEXT` | 需统一为 setText |
| 按键 | `pressKey(PhoneKey)` | `GlobalActionTool`（BACK/HOME/RECENTS 等） | `PhoneKey` 与全局动作需映射 |
| 应用列表 | `listApps()` | `AppLauncherTool` | 合并 |
| 打开应用 | `openApp(packageName)` | `AppLauncherTool` | 合并 |
| 操作状态广播 | `PhoneUseManager`：`controller`/`acting` StateFlow | `running`/`lastActions` StateFlow + 日志环 | 主体有操作日志环（`LOG_RING_SIZE`），官方无 → **保留主体** |
| 禁操作应用名单 | `b10c16857` 把微信加入禁止列表 | 主体无对应机制 | **吸收官方**（安全增强） |
| 被系统停掉检测 | `b7cf74ddc` 识别无障碍服务被停并提示重开 | 主体有 `running` 但无「被停」主动提示 | **吸收官方** |
| 截图位图回收 | `64452581d` 用完立即回收 | 主体已按 SDK 版本条件回收（`canRecycle`） | 等价，保留主体 |
| 悬浮窗保持亮屏 | `7677f649f` | 主体无 | 评估后决定 |
| 消息按动作显示标题图标 | `ffb1c79e1` + `PhoneUseToolUI.kt` | 主体工具 UI 独立 | UI 层最后处理 |

---

## 3. 冲突面（规范第 10 节逐项）

规范要求检查 8 项，实测结论：

| # | 检查项 | 结论 |
|---|---|---|
| 1 | **工具注册入口** | 官方：`PhoneUseTool.kt`（1 个工具，多 action）；主体：`tools/local/` 91 文件，多工具分立。→ 入口不同，**不冲突但要统一命名空间** |
| 2 | **实际执行器** | 官方 `PhoneController` → `PhoneUseAccessibilityService`；主体 `AccessibilityServiceHandle` → `RikkaAccessibilityService`。→ **重复** |
| 3 | **权限来源** | 两者都靠系统无障碍授权（`BIND_ACCESSIBILITY_SERVICE`）。→ **会要求用户授权两次** |
| 4 | 截图/界面读取/点击/滑动/输入实现 | 见第 2 节，**能力重叠度高** |
| 5 | **并发操作与操作队列** | 官方 `PhoneUseManager.acting` 单标志；主体 `running` + 手势 Handler。→ 都**没有真正的串行队列**，叠加会乱序 |
| 6 | 取消 / 超时 / 失败恢复 | 官方 `dispatchGesture` 带 callback；主体 `dispatchGestureAsync` 带 callback。→ 均无统一超时策略 |
| 7 | **服务生命周期** | 两个 service 各自 `onServiceConnected`/`onDestroy`。→ **必须只保留一个** |
| 8 | 后台限制与系统回收后恢复 | 官方有「被停后提示重开」（`b7cf74ddc`）；主体无。→ **吸收官方** |

---

## 4. 统一调度层设计（建议）

```
                    ┌─────────────────────────────┐
   模型 Tool Call ──►│  DeviceAutomationRouter     │  ← 统一入口，单串行队列
                    │  - 串行执行（Mutex/Channel） │
                    │  - 统一超时 + 取消           │
                    │  - 统一权限检查              │
                    └──────────┬──────────────────┘
                               │
                   ┌───────────┴────────────┐
                   │                        │
        ┌──────────▼─────────┐    ┌─────────▼──────────┐
        │ GMYSJ Device Tools │    │ PhoneUseTool(适配) │
        │ (91 工具，已验证)   │    │ 仅做参数映射        │
        └──────────┬─────────┘    └─────────┬──────────┘
                   └───────────┬────────────┘
                               │
                 ┌─────────────▼──────────────┐
                 │ 唯一 AccessibilityService  │
                 │ RikkaAccessibilityService  │
                 │ + 官方被停检测/禁止名单     │
                 └────────────────────────────┘
```

**要点**：
1. **只保留一个** `AccessibilityService`（主体 `RikkaAccessibilityService`），官方
   `PhoneUseAccessibilityService` 不移植 service 本体，只移植其**被停检测**与**禁止操作应用名单**逻辑。
2. 官方 `PhoneController` 的方法签名（`gesture`/`setText`/`pressKey`/`openApp`/`captureScreen`）
   作为**适配层接口**，内部全部转调主体 `AccessibilityServiceHandle`。
3. 加**单串行队列**（两边都没有），避免自动化操作乱序——这是规范第 10 节第 5 条的直接要求。
4. 官方 `PhoneUseTool` 的工具名与参数对模型可见，需决定是否与主体同名工具**并存**
   （建议：主体工具为主，`phone_use` 作为高层封装，避免模型困惑）。
5. 禁止绕过审批：`phone_use` 属高风险管理操作，必须走 `ToolApprovalDefaults`。

---

## 5. 移植顺序（不在本轮执行）

| 步骤 | 内容 | 风险 |
|---|---|---|
| 1 | 移植「被停检测 + 提示重开」（`b7cf74ddc`），纯增量，无冲突 | 低 |
| 2 | 移植「禁止操作应用名单」（`b10c16857`），纯增量 | 低 |
| 3 | 增加单串行队列 + 统一超时（主体侧改造） | 中 |
| 4 | 建 `DeviceAutomationRouter` 适配层，Phone Use 仅映射参数 | 中 |
| 5 | 移植 `PhoneUseTool` + `PhoneUseToolUI`，接审批 | 中 |
| 6 | 决定是否停用官方 service，做一次迁移说明 | 高 |

**本轮不执行任何上述步骤** —— 需先有真机回归能力（本机无 ADB），否则无法验证「不抢屏幕」。
