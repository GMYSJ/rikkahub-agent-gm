# 同步记录模板 / SYNC TEMPLATE

> 每轮同步复制本模板，填完归档到 `CHANGELOG.md`。

---

## 第 N 轮同步 — YYYY-MM

### 1. 基准

| 字段 | 值 |
|---|---|
| 本轮集成分支 | `integration/upstream-YYYYMM` |
| 主体起始 Commit | `<sha>` |
| 上一轮已同步官方 Commit | `<sha>` |
| 本轮目标官方 Commit | `<sha>` |
| 目标官方 Tag | `X.Y.Z` |
| 官方 master HEAD | `<sha>` |
| 同步日期 | YYYY-MM-DD |

### 2. 前置校验（必须全绿才继续）

```bash
git fetch official --tags --filter=blob:none
git merge-base HEAD official/master          # 必须返回 SHA，不能为空
git rev-list --count HEAD..official/master   # 待同步提交数
git describe --tags --abbrev=0 official/master
git status --porcelain                       # 必须为空
```

- [ ] `merge-base` 非空
- [ ] 工作区干净
- [ ] 已记录起始 Commit（可回滚点）

### 3. 官方变更盘点

| 类型 | 数量 |
|---|---|
| 新增提交 | |
| `feat` | |
| `fix` | |
| `refactor` | |
| 安全修复 | |

按模块分布：

| 模块 | 提交数 | 是否触及主体独有能力 |
|---|---|---|
| | | |

### 4. 影响分析

- [ ] 找出改动文件与模块
- [ ] 识别新增 / 删除 / 重命名 / 重构
- [ ] 找出主体对应实现
- [ ] 识别数据结构与 API 变化
- [ ] 识别权限 / 后台服务 / 生命周期变化
- [ ] 识别依赖升级
- [ ] **评估是否影响 Agent 工具执行链**（最高优先级）

### 5. 移植清单

| # | 功能 | 官方 Commit | 主体文件 | 迁移方式 | 状态 | 提交 SHA |
|---|---|---|---|---|---|---|
| 1 | | | | | 待办/完成/跳过 | |

### 6. 跳过项与理由（不可悄悄遗漏）

| 功能 | 官方 Commit | 不移植理由 | 影响 | 复查条件 | 复查时间 |
|---|---|---|---|---|---|
| | | | | | |

### 7. 冲突处理记录

| 冲突点 | 类型 | 处理方式 | 依据 |
|---|---|---|---|
| | | | |

### 8. 验证结果

| 验证项 | 结果 | 证据 |
|---|---|---|
| CI 编译（Debug） | 通过/失败/未测试 | run 链接 |
| CI 编译（Release 变体） | | |
| 单元测试 | | |
| Agent 工具调用链 | | |
| 旧数据迁移 | | |
| APK 产物 SHA-256 | | |

> 测试状态只允许：通过 / 失败 / 未测试 / 不适用。
> **不能把「编译成功」写成「功能测试通过」。**

### 9. 收尾

- [ ] 更新 `UPSTREAM.md` 的同步基准（记到 **Commit**，不是只记 Tag）
- [ ] 更新 `FEATURE_MATRIX.md` 状态
- [ ] 更新 `CONFLICTS.md`（如有新决定）
- [ ] 更新 `CHANGELOG.md`
- [ ] 更新 `migration-log.md`
- [ ] 记录回滚方式
- [ ] 列明未完成项与已知问题

### 10. 回滚方式

```bash
# 回到本轮开始前的状态
git checkout master
git reset --hard <本轮主体起始 Commit>
```

---

## 可用命令速查

```bash
# 官方 release notes（走 API，避免手抄出错）
curl -sH "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/rikkahub/rikkahub/releases?per_page=10" \
  | python -c "import sys,json;[print(r['tag_name'],'|',r['published_at']) for r in json.load(sys.stdin)]"

# 两仓库真正冲突面
git diff --name-only <base> HEAD > /tmp/fork.txt
git diff --name-only <base> official/master > /tmp/off.txt
comm -12 <(sort /tmp/fork.txt) <(sort /tmp/off.txt)
```
