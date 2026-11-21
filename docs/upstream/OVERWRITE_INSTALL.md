# 覆盖安装与回退策略

> 这是本项目的**硬约束**，不是建议。
> 违反它会导致用户必须卸载重装，而工作区数据有数个 GB，代价极高。

## 1. 需求原话

> 留下老版本覆盖安装新版本的口子。比如我现在这个版本是 #38，
> 新出的版本应该能被这个版本覆盖，不然如果新版本翻车我还得卸载 #38，丢工作区数据。

翻译成技术要求：**任意两个历史包之间必须能双向覆盖安装**。

## 2. Android 的实际规则

覆盖安装必须同时满足三条，缺一条就失败：

| 条件 | 要求 |
|---|---|
| 包名 | 完全相同 |
| 签名 | 同一个 key 签的 |
| versionCode | **不小于**已安装版本 |

versionCode 的三种情况：

| 关系 | 结果 |
|---|---|
| 新包 versionCode **更大** | ✅ 能覆盖（正常升级） |
| 新包 versionCode **相等** | ✅ 能覆盖（**双向都可，可回退**） |
| 新包 versionCode **更小** | ❌ 拒绝 `INSTALL_FAILED_VERSION_DOWNGRADE` |

## 3. 结论：versionCode 必须固定，不能递增

这是本文档最重要的一句话。

**错误做法**（已写过一次，已回滚）：
把 versionCode 设成 `run_number + 190`，看起来"永不倒退"，很合理。
但它直接毁掉回退能力：

```
用户装 #38 (190)  →  装 #43 (233) 成功
#43 出 bug        →  想装回 #38 (190)  →  190 < 233  →  拒绝
结果：必须卸载 #43，工作区数据一起没
```

**正确做法**：所有包 versionCode **恒为 190**。

```
#38 (190) → #43 (190) → #44 (190) → ...
任意方向都能覆盖，出问题直接装回任意历史包，数据不动
```

这也是为什么不能靠"递增"来区分版本 —— 版本区分交给 SHA-256。

## 4. 三项固定值的当前状态

| 项 | 值 | 位置 | 是否受保护 |
|---|---|---|---|
| 包名（release） | `excp.rikkahub.agent` | `app/build.gradle.kts`：`applicationId = "excp.rikkahub"` + release `applicationIdSuffix = ".agent"` | CI 校验 `applicationId` |
| 签名 | `release.keystore`，blob `76298527be95ba3346335607bdc5b78815c07a5c` | 仓库根目录（**被 git 跟踪**） | CI 校验文件存在 |
| versionCode | `190` | `app/build.gradle.kts` | CI 校验必须等于 190，否则构建失败 |

**签名说明**：CI 里 `Ensure fixed signing keystore` 步骤只在 keystore 缺失时才生成新 key。
由于 keystore 已提交到仓库（blob `7629852`），自首次提交后从未变动，
所以所有历史包用的是同一把钥匙 —— 已核实 `2912c2c` 与 `6f889076f` 的 keystore blob 完全相同。

**绝不能做的事**：
- 改 `applicationId`
- 换 `release.keystore` 或重新生成
- 改 `versionCode`
- 把 `versionCode` 改成随 run 递增

任何一条都会让用户无法覆盖安装，且**已经装出去的包无法挽回**。

## 5. 版本怎么区分

versionCode 固定后，靠这三样识别一个包：

1. **构建摘要里的 SHA-256**（CI 每次写入 Step Summary）
2. artifact 名 `RikkaHub-run<N>-arm64`
3. 构建摘要里的 commit SHA

三者都在 `Compute APK SHA-256 and write build summary` 步骤输出。

## 6. CI 里的守卫

`.github/workflows/build-android.yml` 中：

```yaml
- name: Verify versionCode stays fixed (bidirectional overwrite-install)
  run: |
    CODE=$(grep -oP 'versionCode = \K[0-9]+' app/build.gradle.kts | head -1)
    if [ "$CODE" != "190" ]; then
      echo "::error::versionCode 必须是 190，否则新老包无法双向覆盖安装（会丢工作区数据）。"
      exit 1
    fi
    # 同时校验 release.keystore 存在
```

它在单元测试之前执行，构建失败即中断，**不会产出无法覆盖的包**。

## 7. 回退操作指南（给用户）

新版本出问题时：

1. 打开 GitHub Actions，找到想回退到的那个 run（如 #38）
2. 下载 artifact `RikkaHub-run38-arm64`
3. 解压得到 `RikkaHub-2.5.1-agent.4-arm64-v8a.apk`
4. **直接安装**（无需卸载，因为 versionCode 相同、签名相同）

数据（对话、工作区、设置）全部保留。

## 8. 如果将来确实要改 versionCode

只有在**明确接受"此版本之前的所有包都无法再回退"**的前提下才可以。
那种情况下必须：
1. 先让用户确认
2. 备份工作区数据
3. 在 `CHANGELOG.md` 记录新的分界线

否则不要动。
