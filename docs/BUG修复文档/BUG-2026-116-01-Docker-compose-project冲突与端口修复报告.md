# BUG 修复报告：BUG-2026-116-01 · Docker compose project 冲突与端口冲突

> 版本：v1.0 · 状态：已修复并验证（2026-11-16）
> 所属阶段：基础设施运维 · 子任务：Docker 基础设施修复与验证
> 缺陷编号：BUG-2026-116-01 · 严重度：高（P0）
> 关联：car-link-platform 侧修复记录、Docker Desktop 启动修复
> 所属：BUG修复文档

---

## 一、缺陷概述

| 项 | 内容 |
|----|------|
| 编号 | BUG-2026-116-01 |
| 标题 | Docker compose project name 冲突导致 postgres 容器互相覆盖，5432 端口冲突 |
| 严重度 | 高（P0，影响 StoryForgeAI 与 car-link 两套基础设施同时运行） |
| 发现阶段 | 11-16 Docker 基础设施启动验证 |
| 复现概率 | 稳定复现（两个 compose 均依赖目录名默认 project `infra`） |
| 引入阶段 | 两个仓库均在 `infra/` 目录放置 compose 且未指定 project name |
| 修复阶段 | 11-16 基础设施修复与验证 |

---

## 二、复现步骤（未复现不得进入修复）

1. 启动 Docker Desktop，确认引擎可用（`docker info` 返回 Server）；
2. 在 car-link 目录执行 `docker compose -f infra/docker-compose.yml up -d`；
3. 再在 StoryForgeAI 目录执行 `docker compose -f infra/docker-compose.yml up -d`；
4. 观察：第二个 compose 的 `postgres` 服务顶替/覆盖第一个 compose 的 `postgres` 容器，5432 端口争抢，出现启动异常或服务错绑。

**复现确认**：以上步骤稳定复现 project 冲突与端口争抢，符合"未复现不得进入修复"的硬规则。

---

## 三、影响范围

| 项 | 影响 |
| --- | --- |
| compose project | 两个仓库共用 `infra` project，同名服务互相顶替 |
| 端口 5432 | car-link 与 StoryForgeAI 的 postgres 均映射 5432，冲突 |
| 数据卷 | project 冲突导致卷归属错乱，存在数据错绑风险 |
| 数据库连接 | StoryForgeAI 的连接串 `127.0.0.1:5432` 指向 car-link 的 postgres |

---

## 四、根因

### 4.1 根因机制（核心）

- 两个 compose 均在 `infra/` 目录且**未指定 project name**，Docker Compose 默认用目录名 `infra` 作为 project name。
- 结果：car-link 与 StoryForgeAI 的 compose 共用同一 project `infra`，同名服务（`postgres`）互相顶替。
- **端口冲突（5432）只是表象，真正根因是 project name 冲突。**

### 4.2 辅助根因：daemon.json BOM

- Docker Desktop 冷启动迁移读取 `daemon.json` 时因文件带 UTF-8 BOM，JSON 解析失败（`invalid character 'ï'`），引擎从未启动，叠加了启动失败表象。

---

## 五、修复方案（最小改动）

### 5.1 compose 独立 project name

StoryForgeAI 的 `infra/docker-compose.yml` 顶部加 `name: storyforge`：

```yaml
# 独立 project name，避免与 car-link 的 compose（同目录 infra/）共用 project `infra` 导致容器/卷互相覆盖
name: storyforge
```

### 5.2 端口错开

`postgres` 端口 `5432:5432` → `5433:5432`，避免与 car-link 的 5432 冲突：

```yaml
services:
  postgres:
    image: postgres:16
    ports:
      - "5433:5432"
```

### 5.3 卷复用（防数据"丢失"）

数据卷改为复用既有卷（原 project `infra` 下创建，必须 `external: true` 才能复用）：

```yaml
volumes:
  storyforge_pg:
    name: infra_storyforge_pg
    external: true
```

### 5.4 连接串同步（9 处）

修改 `DATABASE_URL` / `TEST_DATABASE_URL` 默认端口 5432 → 5433，涉及：

- `.env.example`
- `apps/api/src/config/env.ts`（默认值）
- `apps/api/test/test-database.ts`（`DEFAULT_TEST_DATABASE_URL`）
- `tests/e2e/e2e-env.ts`
- `scripts/verify-m0.mjs`、`verify-m1.mjs`、`verify-m1-db-failure.mjs`
- `.github/workflows/ci.yml`（CI 环境变量硬编码 5432 → 5433）

> 【注意】CI 环境变量也必须同步，否则 CI 连库会失败。

---

## 六、单元测试

本次为基础设施配置修复（compose/端口/连接串），不涉及业务逻辑代码，**无新增单元测试**；以 compose 校验 + 容器启动验证 + 数据库连接验证替代。

| 验证项 | 方式 | 结果 |
| --- | --- | --- |
| compose 配置合法 | `docker compose -f infra/docker-compose.yml config` | ✅ 通过 |
| 端口不冲突 | `netstat -ano` 探测 5433 监听 | ✅ 5433 OPEN |
| 数据库连通 | 容器内 `psql` 连接 StoryForgeAI 库 | ✅ 连通 |

---

## 七、手动验证步骤

1. 重启 Docker Desktop，确认引擎可用（`docker info` 有 Server）；
2. 在 StoryForgeAI 目录执行 `docker compose -f infra/docker-compose.yml up -d`；
3. 执行 `docker compose -f infra/docker-compose.yml ps`，确认 `postgres` 为 Up；
4. 执行 `netstat -ano | findstr :5433`，确认 5433 端口监听；
5. 在 car-link 目录执行 `docker compose -f infra/docker-compose.yml up -d`，确认 car-link 的 postgres 也在 5432 正常监听；
6. 两套库各自连接（`psql` 分别连 5432 / 5433），确认数据隔离、卷复用无损。

---

## 八、同类问题排查指引

### 8.1 快速定位（三问）

1. **两个 compose 是否共用同一目录名？** → `docker compose ls` 看 project 是否重复；
2. **daemon.json 是否带 BOM？** → 十六进制查看首 3 字节是否 `EF BB BF`；
3. **端口是否被占用？** → `netstat -ano | findstr :<port>`。

### 8.2 标准排查命令

```powershell
docker compose ls
docker inspect <container> | ConvertFrom-Json | Select-Object -ExpandProperty Config.Labels
docker compose -f infra/docker-compose.yml config
netstat -ano | findstr :5433
```

### 8.3 数据安全红线

- **project 改名必须复用旧卷**（`name:` + `external: true`），否则数据"丢失"；
- **改动前备份 compose**（`docker-compose.yml.bak-project`，已 gitignore）；
- **禁用 `docker compose down -v`**。

---

## 九、预防措施

1. **每个仓库独立 `name:`**：所有 compose 显式声明，禁止依赖目录名默认值；
2. **daemon.json 必须无 BOM**：脚本写 daemon.json 一律 `UTF8Encoding($false)`；
3. **端口规划**：不同仓库基础服务端口不重叠（car-link 5432，StoryForgeAI 5433）；
4. **CI 校验**：compose 变更时执行 `docker compose config`。

---

## 十、注意事项

- **容器无 `restart: unless-stopped`**：系统重启后需手动拉起（用户明确保留现状）；
- **Trae 沙箱限制**：涉及 `wsl.exe` / Roaming 写入需沙箱外执行；
- **禁止 `docker compose down -v`**：仅在确认可丢数据时使用。

---

## 十一、涉及文件清单

| 文件 | 变更 |
| --- | --- |
| `infra/docker-compose.yml` | 加 `name: storyforge`、端口 5433、卷 `external` 复用 |
| `.env.example` | 连接串 5432 → 5433 |
| `apps/api/src/config/env.ts` | 默认值 5432 → 5433 |
| `apps/api/test/test-database.ts` | `DEFAULT_TEST_DATABASE_URL` 5432 → 5433 |
| `tests/e2e/e2e-env.ts` | 5432 → 5433 |
| `scripts/verify-m0.mjs`、`verify-m1.mjs`、`verify-m1-db-failure.mjs` | 默认 `databaseUrl` 5432 → 5433 |
| `.github/workflows/ci.yml` | CI 环境变量 5432 → 5433 |
| `.gitignore` | 加 `infra/docker-compose.yml.bak-project` |

---

## 十二、遗留与建议

1. **重启策略**：容器当前无 `restart: unless-stopped`，系统重启后需手动拉起，建议后续补上；
2. **compose 规范**：建议在开发规范中明确"每仓库独立 `name:`"硬约束，防止再次踩坑。

---

## 十三、关联文档

- car-link 侧修复记录：`car-link-platform/docs/开发记录/2026-11-16-docker-compose-端口与project冲突修复记录.md`
- 本仓库 2026-11-13 BUG 先例：[BUG-2026-113-01-Windows原子写竞态修复报告](./BUG-2026-113-01-Windows原子写竞态修复报告.md)

---

## 十四、变更记录

| 日期 | 版本 | 变更摘要 | 作者 |
| --- | --- | --- | --- |
| 2026-11-16 | v1.0 | 初版：记录 Docker compose project 冲突与端口冲突排查、修复与验证闭环 | 基础设施维护 |
