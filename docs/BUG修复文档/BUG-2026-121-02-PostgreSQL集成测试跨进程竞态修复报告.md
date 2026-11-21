# BUG 修复报告：BUG-2026-121-02 · PostgreSQL 集成测试跨进程竞态

> 版本：v1.0 · 状态：已修复并验证（2026-11-21）
> 所属阶段：测试基础设施 · 子任务：PostgreSQL 集成测试稳定性修复
> 缺陷编号：BUG-2026-121-02 · 严重度：高（P1）

---

## 一、缺陷概述

多个独立 Vitest 进程（包括不同 Git worktree 中的进程）共用 `storyforge_test`。各进程在建测试夹具时会 DROP 表并重新执行迁移，导致另一个进程的表结构、连接和断言被中途破坏。

典型错误包括：

- `relation "authors" already exists`
- `relation "ai_tools" does not exist`
- `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`
- `deadlock detected`
- 初始化失败后续出现的 `Driver not Connected`、夹具为 `undefined`

最近一次失败 CI 的结果为 30 个测试文件失败、200 个测试失败。受控双进程复现中，角色服务测试 16/22 失败，智能体服务测试 19/25 失败。

## 二、复现步骤

在仓库根目录打开两个 PowerShell 窗口，同时分别执行：

```powershell
pnpm vitest run --project @storyforge/api src/character/character.service.test.ts
```

```powershell
pnpm vitest run --project @storyforge/api src/agent/agent.service.test.ts
```

修复前两个进程会并发重置同一个测试库，稳定出现上述目录项重复、关系缺失和死锁错误。单进程串行运行相同测试则可以通过，说明问题不在业务断言或迁移本身。

## 三、根因

`apps/api/vitest.config.ts` 原有的 `fileParallelism: false` 与 `poolOptions.forks.singleFork: true` 只能序列化**同一个 Vitest 进程内**的测试文件，无法约束：

- 同时启动的另一个 Vitest 进程；
- 另一个 Git worktree 中运行的测试；
- 其他直连同一 `TEST_DATABASE_URL` 的测试运行器。

因此，仅缩短 DROP/迁移时间、仅给迁移局部加锁，或使用 `IF NOT EXISTS` 都不能解决问题：另一个进程仍可能在当前进程执行断言期间重置数据库。互斥范围必须覆盖整个 API 测试项目。

## 四、最小修复方案

1. 为 API Vitest 项目配置 `globalSetup`。
2. `globalSetup` 使用专用 `pg.Client` 连接测试库，并调用 PostgreSQL 会话级 `pg_advisory_lock`。
3. 锁由该专用连接持有，覆盖 API 测试项目的完整生命周期；其他进程调用同一锁时会等待。
4. 返回的 teardown 调用 `pg_advisory_unlock` 并关闭连接；若进程或数据库会话异常终止，PostgreSQL 会自动释放会话级锁。
5. 不修改业务代码、迁移、表结构或既有业务断言。

## 五、防复发测试（TDD）

在 `apps/api/test/database.e2e-spec.ts` 新增真实 PostgreSQL 回归测试：

- 使用另一个独立 `pg.Client` 调用 `pg_try_advisory_lock`；
- API 测试项目运行期间，该观察者必须获得 `false`，证明锁已由测试运行器持有；
- 无论断言结果如何，观察者连接均在 `finally` 中关闭。

验证顺序：

| 阶段 | 结果 |
| --- | --- |
| RED：实现锁之前 | 按预期失败：`expected true to be false`，证明当时没有跨进程锁 |
| GREEN：配置 globalSetup 后 | 1 个目标测试通过，另 1 个未选中测试跳过 |

## 六、验证结果

| 验证项 | 命令 / 方式 | 结果 |
| --- | --- | --- |
| 角色与智能体双进程复现 | 并行执行两个原始复现命令 | 通过：角色 22/22，智能体 25/25；等待锁的进程也正常结束，证明锁释放有效 |
| 数据库与角色 E2E | `pnpm vitest run --project @storyforge/api test/database.e2e-spec.ts test/character.e2e-spec.ts` | 通过：2 个文件，37/37 测试 |
| API 类型检查 | `pnpm --filter @storyforge/api typecheck` | 通过 |
| 完整 API 套件 | `pnpm vitest run --project @storyforge/api` | 通过：48 个文件，443/443 测试 |
| 差异格式检查 | `git diff --check -- apps/api/vitest.config.ts apps/api/test/test-database.ts apps/api/test/database.e2e-spec.ts` | 通过 |
| 完整 CI | `pnpm run ci`（隔离环境，无并发工作树争抢） | 通过：lint、typecheck、8/8 Node 测试、99 个 Vitest 文件（767/767 测试）及生产构建，退出码 0。注：此前一次 CI 失败系另一工作树（`StoryForgeAI-ui-rebuild`）并发争抢同一测试库所致，非本修复缺陷；隔离环境下复跑通过 |

## 七、手动验证步骤

> 注意：以下命令会清空并重建 `TEST_DATABASE_URL` 指向的测试表。必须确认数据库名以 `_test` 结尾，禁止指向开发库或生产库。本缺陷属于测试基础设施，无浏览器页面或按钮操作。

1. 确认 PostgreSQL 测试实例已启动，且 `TEST_DATABASE_URL` 指向独立测试库；未设置时使用 `postgresql://storyforge:storyforge@127.0.0.1:5433/storyforge_test`。
2. 在仓库根目录执行单测试命令：

   ```powershell
   pnpm vitest run --project @storyforge/api test/database.e2e-spec.ts -t "holds the cross-process database lock for the whole API test project"
   ```

   预期：命令退出码为 0，目标测试通过；另一个未选中的数据库测试显示 skipped。

3. 打开两个 PowerShell 窗口，均进入仓库根目录，同时分别运行角色与智能体测试命令（见第二节）。
   预期：两个命令最终退出码均为 0；后启动的进程可能等待，但不得出现 `already exists`、`does not exist`、目录唯一键冲突或死锁。
4. 执行 `pnpm vitest run --project @storyforge/api`。
   预期：全部 API 测试文件和测试通过，命令退出码为 0。
5. 执行 `pnpm run ci`。
   预期：contracts 构建、lint、typecheck、完整测试和 build 全部通过，最终命令退出码为 0。

## 八、涉及文件

| 文件 | 变更 |
| --- | --- |
| `apps/api/vitest.config.ts` | 注册 API 项目级 `globalSetup` |
| `apps/api/test/global-setup.ts` | 新增专用连接、全项目 advisory lock 与 teardown 释放逻辑 |
| `apps/api/test/test-database.ts` | 导出 setup 与回归测试共用的固定双整数锁键 |
| `apps/api/test/database.e2e-spec.ts` | 新增独立连接无法获取同一锁的防复发测试 |

## 九、预防与边界

- 所有会重建同一测试库的独立测试进程，都必须进入相同的跨进程互斥范围，不能只依赖 Vitest 进程内串行配置。
- 不得通过放宽断言、隐藏异常、增加 `IF NOT EXISTS` 或修改业务迁移来掩盖此类竞态。
- 锁键必须集中定义，避免 setup 与回归测试使用不同键而形成虚假通过。
- 不同测试库若未来需要并行，应使用相互独立的 `TEST_DATABASE_URL`；当前方案选择串行保护共享测试库。
