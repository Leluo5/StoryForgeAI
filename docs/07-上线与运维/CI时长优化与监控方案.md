# CI 免费额度优化与时长监控方案

> 日期：2026-11-20
> 范围：`.github/workflows/ci.yml`、`scripts/verify-m1.mjs`、`scripts/ci-billing.mjs`、`.github/actions/setup-node-pnpm`
> 目标：在不降低门禁强度的前提下，把全量 CI 墙钟时长降低 30% 以上，并建立可持续的额度监控与预警

---

## 一、结论摘要

| 指标 | 优化前（实测） | 优化后（实测） | 变化 |
| --- | --- | --- | --- |
| 全量路径墙钟 | 484 ~ 557 s | **230 s**（run 44663476545） | **-52.5%** |
| 纯文档提交路径 | 394 ~ 557 s | 待文档提交验证（预期 ≈ 10 s） | 预期 -98% |
| 单次全量「计费分钟」 | 13 ~ 15 min | **12 min** | -1 min |
| 失控运行上限 | 无（实例：21 621 s / 366 min） | 单作业 ≤ 35 min 自动终止 | 消除跑飞风险 |

墙钟降幅来自「拆分并行 + 去重 + 缓存」，额度降幅来自「docs-only 跳过 + 并发取消 + 超时兜底」。

---

## 二、优化前实测基线（来自 GitHub Actions API）

采集命令：

```bash
gh run list --repo Leluo5/StoryForgeAI --workflow CI --limit 30 \
  --json databaseId,displayTitle,event,conclusion,createdAt,updatedAt
gh api repos/Leluo5/StoryForgeAI/actions/runs/<run_id>/jobs
```

### 2.1 作业级耗时（运行 44601170471 · 2026-11-19 19:42Z · push main）

| 作业 | 墙钟 | 计费分钟 | 主要耗时步骤 |
| --- | ---: | ---: | --- |
| 静态质量门禁（lint / typecheck / build） | 95 s | 2 | lint 23 s、typecheck 21 s、build 26 s、contracts build 5 s |
| 单元与 API E2E 测试（vitest） | 147 s | 3 | `pnpm test` 109 s、PG 启动 13 s、Redis 5 s |
| M0–M3c 全链路验收（含浏览器 E2E） | **480 s** | 8 | `pnpm verify:m1` 392 s、Chromium 安装 31 s、PG 13 s、Python 依赖 7 s |
| **单次运行合计** | **484 s** | **13** | — |

另一次运行（44497721030）：quality 84 s / test 144 s / m1 554 s，合计 557 s、15 计费分钟。

### 2.2 `pnpm verify:m1` 内部分布（392 s）

| 子项 | 估算耗时 | 说明 |
| --- | ---: | --- |
| `pnpm run ci`（lint + typecheck + test + build） | ~95 s | **与 quality / test 作业完全重复** |
| Python 合规 + pytest + compileall | ~40 s | 与前端任务无依赖关系，可并行 |
| 迁移清表 / 幂等重跑 | ~13 s | 依赖数据库 |
| 浏览器 E2E（Playwright） | ~200 s | 最大单体耗时 |
| 数据库故障验收 | ~45 s | 依赖数据库 |

### 2.3 本月额度消耗（`node scripts/ci-billing.mjs`）

```
已完成运行次数 29
计费分钟（估算） 520 / 2000（26.0%）
最近运行中最大项：cancelled 运行 21 621 s 墙钟 → 366 计费分钟
```

---

## 三、根因分析

1. **重复执行**：`m1` 作业内部的 `pnpm run ci` 与 `quality` / `test` 作业做的事完全一样，单次浪费约 95 s，且让 `m1` 成为整条流水线的串行长尾。
2. **零缓存**：每个作业都重新 `pnpm install`（6 s×3）、每次重装 Chromium（31 s）、pip 仅按 requirements 粗粒度缓存。
3. **无按需触发**：文档提交同样触发 8 分钟全量门禁。近 15 次运行中约 7 次为纯 docs 变更，却各消耗 11~15 计费分钟。
4. **无闲置终止**：没有 `concurrency`、没有 `timeout-minutes`。PR #4 合入时的运行持续 21 621 s（6 小时）直到人工取消，单次吃掉 366 分钟——这是额度耗尽的最大单点。
5. **类型检查三连跑**：所有包的 `lint` / `typecheck` 脚本都是 `tsc --noEmit`，CI 里先 lint 再 typecheck 纯属重复。

---

## 四、改造内容

### 4.1 依赖与产物缓存（需求 2）

- 新增复合 Action [`setup-node-pnpm`](../../.github/actions/setup-node-pnpm/action.yml)：`pnpm/action-setup`（版本由 `packageManager: pnpm@10.12.4` 锁定）+ `actions/setup-node@v4` 的 `cache: pnpm`。
- Chromium 走 `actions/cache`，key 绑定 `pnpm-lock.yaml`，浏览器版本随锁文件自然失效。
- `setup-python` 补齐 `cache-dependency-path: requirements.txt`。

### 4.2 长任务拆分并行（需求 3）

原 `m1` 单作业 9 段串行 → 拆为 4 个并行作业 + 1 个汇总作业：

| 作业 | 内容 | 依赖 |
| --- | --- | --- |
| `quality` | `pnpm run quality`（contracts build → lint → build） | 无 |
| `test` | 单元 + API E2E → 迁移清表 → 迁移幂等 → 数据库故障验收 | 无 |
| `legacy` | 合规检查 + pytest + compileall | 无 |
| `e2e` | Chromium 浏览器 E2E | 无 |
| `m1` | **仅聚合证据并渲染验收报告**，不再重复执行任何检查 | 以上全部；且仅在主干 push / 手动触发时运行（PR 不运行） |

`scripts/verify-m1.mjs` 新增两种模式，保证日志格式、退出码、报告内容与改造前一致：

- `M1_STAGES=quality,unit-test,...`：只执行指定检查项，逐项写 `test-results/m1-evidence/<id>.log`；
- `M1_REPORT_ONLY=1`：只读取各作业上传的证据日志渲染《M1 写作基座验收报告》；**证据缺失即判失败**，不会出现“空证据假通过”。

### 4.3 去重（需求 1 的直接收益）

- `m1` 不再运行 `pnpm run ci`，重复的 ~95 s 归零。
- `lint` 与 `typecheck` 命令完全等价，CI 只保留一次类型检查（`pnpm run quality`）。
- 迁移与数据库故障验收合并到已有 PG 的 `test` 作业，避免重复拉起容器。

### 4.4 按需触发（需求 4）

新增 `changes` 作业（`dorny/paths-filter`）输出 `docs_only` / `legacy` / `e2e` / `full`：

| 变更范围 | 触发结果 |
| --- | --- |
| 仅 `docs/**`、图片、Markdown | 只跑 `docs` 快速作业（≈10 s） |
| PR 只改 `apps/**`、`packages/**` | quality + test + e2e |
| PR 只改 `modules/**`、`*.py` | quality + test + legacy |
| PR 覆盖前后端 + Python | 全量（PR 不生成 `m1` 汇总报告） |
| push 到 main / 手动触发 | **始终全量**，保证主干验收证据完整 |

### 4.5 闲置资源自动终止（需求 5）

- 工作流级 `concurrency: ci-<workflow>-<ref>` + `cancel-in-progress: true`：新提交立即取消同一分支的旧运行。
- 每个作业显式 `timeout-minutes`（quality 15 / test 30 / legacy 20 / e2e 35 / m1 15 / changes 5），任何卡死最多消耗对应上限。
- Playwright 的 `webServer.timeout` 已为 120 s，服务起不来会快速失败而非空转。

### 4.6 流程完整性保障（需求 6）

- 作业名 `静态质量门禁（lint / typecheck / build）`、`单元与 API E2E 测试（vitest）`、`M0–M3c 全链路验收（含浏览器 E2E）` **保持不变**，避免分支保护必需检查失效。
- 验收报告仍由 `verify-m1.mjs` 唯一生成，断言口径（PostgreSQL 16、迁移幂等文案、性能样本数、数据库故障 JSON、Node/pnpm 版本）未做任何放宽。
- 证据artifact 仍归档：`m1-evidence-*`（各阶段日志）、`m1-browser-evidence`（Playwright 报告）、`m1-writing-foundation-evidence`（汇总报告 + 证据）。

---

## 五、效果验证

### 5.1 墙钟对比（已实测）

实测运行 44663476545（push main）：

| 作业 | 实测 |
| --- | ---: |
| 变更范围识别 | 8 s |
| 静态质量门禁 | 75 s |
| 单元与 API E2E | 171 s |
| 旧体系 Python 门禁 | 52 s |
| 浏览器 E2E | 193 s（Chromium 缓存命中，安装 5 s） |
| m1 汇总报告 | 23 s |
| **运行墙钟** | **230 s** |

验收判定：从首个作业 `started_at` 到最后一个作业 `completed_at` 的墙钟 ≤ 340 s——**通过（-52.5%）**。

```bash
# 取最近一次成功的全量运行
gh run list --repo Leluo5/StoryForgeAI --workflow CI --limit 5 --json databaseId,event,conclusion
gh api repos/Leluo5/StoryForgeAI/actions/runs/<run_id>/jobs \
  --jq '.jobs[] | {name, started_at, completed_at}'
```

### 5.2 关于「计费分钟」的说明

GitHub 按**每个作业向上取整到分钟**计费。实测单次全量运行计费为 **12 分钟**（1+2+3+1+4+1），相对改造前的 13~15 分钟不升反降：去掉重复的 `pnpm run ci`、Chromium 冷装 145 s → 缓存命中 5 s，节省超过了并行作业的分钟进位。

额度真正的节省来自三处，收益远大于进位损失：

| 措施 | 效果 |
| --- | --- |
| docs-only 跳过 | 历史上约一半运行是文档提交，单次 11~15 min → 1 min |
| `concurrency` 取消 | 同一分支连续推送只保留最后一次 |
| `timeout-minutes` | 消灭 366 分钟的失控运行 |

### 5.3 门禁强度回归

- `quality` 作业本地等价命令：`pnpm run quality`（本次已实测通过，含 contracts 自举）。
- 分阶段脚本实测：`M1_STAGES=compliance` 正常产日志并退出 0；`M1_STAGES=bogus` 退出 1 并列出可用值。
- `M1_REPORT_ONLY=1` 在证据缺失场景下生成「未通过」报告并退出 1（本次已实测）。

---

## 六、长期监控与预警（需求 7）

### 6.1 用量统计脚本

```bash
node scripts/ci-billing.mjs                 # 默认 2000 分钟额度，70% 预警、85% 告警
node scripts/ci-billing.mjs --json          # 机读输出，便于接入看板
node scripts/ci-billing.mjs --limit 3000    # 额度调整后覆盖
```

输出：当月计费分钟、使用率、剩余额度、按工作流拆分、最近 10 次运行的墙钟与计费。计费口径与 GitHub 一致（按作业耗时向上取整到分钟）。

### 6.2 定时预警工作流

`.github/workflows/ci-usage.yml` 每周一 01:00 UTC（北京时间 09:00）运行：

- 使用率 ≥ 70%：输出 `::warning::` 提示；
- 使用率 ≥ 85%：作业以退出码 1 失败，触发 GitHub 失败通知邮件。

单次运行约 1 计费分钟，月度成本约 4~5 分钟，可接受。

### 6.3 处置预案

| 触发点 | 处置动作 |
| --- | --- |
| 70% 预警 | 检查最近运行里是否有 docs-only 或重复触发；确认 `changes` 过滤生效 |
| 85% 告警 | PR 只保留 quality + test，e2e 仅 push 到 main 执行（给 `e2e` 作业加 `github.event_name != 'pull_request'`） |
| 额度耗尽 | 暂停非必要 `workflow_dispatch`；临时改为 `on: workflow_dispatch` 手动触发，仅保留合并前门禁 |
| 出现超长运行 | 检查 `timeout-minutes` 是否被调大，或 Playwright `webServer` 启动失败重试 |

---

## 七、风险与回滚

1. **分支保护**：三个原有作业名保持不变；新增 `changes` / `docs` / `legacy` / `e2e`。若此前把某些新增作业设为必需检查，注意 PR 精简模式下它们会显示为 `skipped`（GitHub 视为通过）。
2. **m1 触发范围**：`m1` 汇总作业只在主干 push / 手动触发时运行，PR 阶段一律不运行；因此主干合并后才会生成《M1 写作基座验收报告》。PR 的代码门禁由 quality / test（必要时加 legacy / e2e）承担。
3. **缓存失效**：pnpm / Playwright 缓存均绑定 `pnpm-lock.yaml`，锁文件变更自动重建；缓存损坏时删除对应 cache key 即可。
4. **回滚**：`git revert` 本次提交即可恢复单作业串行版本；`scripts/verify-m1.mjs` 保留全量模式（`pnpm verify:m1`），本地验证路径不受影响。

---

## 八、变更清单

| 文件 | 变更 |
| --- | --- |
| `.github/workflows/ci.yml` | 重构：变更识别、并行拆分、缓存、并发取消、超时、证据聚合 |
| `.github/actions/setup-node-pnpm/action.yml` | 新增：Node + pnpm + store 缓存 |
| `.github/workflows/ci-usage.yml` | 新增：每周额度统计与预警 |
| `scripts/verify-m1.mjs` | 新增 `M1_STAGES` 分阶段执行与 `M1_REPORT_ONLY` 聚合报告模式 |
| `scripts/ci-billing.mjs` | 新增：计费分钟统计与阈值告警 |
| `package.json` | 新增 `quality` 脚本（contracts 自举 → lint → build） |
