# F1 · 资源拉取与批量导入 · 分册索引

> 所属：[《功能交付档案》总索引](../README.md)｜第 1 / 4 篇
> 返回：[文档中心](../../README.md)

## 一、来源说明

本功能档案由 SpecForge 功能级工作流（需求澄清 → 技术方案 → 任务规划）生成，共 3 篇分册，对应 StoryForgeAI 的 F1 功能模块（资源拉取与批量导入）。

## 二、篇章导航

| 编号 | 分册 | 内容概要 | 状态 |
| --- | --- | --- | --- |
| 01 | [需求澄清](./01-需求澄清.md) | 用户要什么、流程、边界、验收标准 | 已定稿 |
| 02 | [技术方案](./02-技术方案.md) | API 设计、数据流、异常处理、Coze 对接 | 已定稿 |
| 03 | [任务规划](./03-任务规划.md) | 任务拆解、依赖、完成标准、高风险标注 | 已定稿 |

## 三、阅读路径

- **顺序阅读**：01 → 02 → 03（需求 → 方案 → 任务）。
- **按需跳读**：仅看技术细节 → 02；仅看排期 → 03。
- **回溯原文**：本档案对应 SpecForge 功能级产出，无独立母文档。

## 四、功能说明

- **功能名**：资源拉取与批量导入
- **核心目标**：管理员从 Coze 平台拉取 bot / dataset 资源并分类导入：Bot 进入 Agent 管理（AgentEntity），dataset 进入知识库（KnowledgeEntryEntity）。
- **涉及代码**：`apps/api/src/collab/coze-import.{client,service,controller}.ts`、`apps/web/src/agent/coze-import-{client,panel}.tsx`、`packages/contracts/src/coze-import.ts`（见 02-技术方案.md）。
- **2026-11-21 归属修正**：Coze Bot 是 Agent 智能体，不再创建展示作品；重复导入按 `bot_id` 更新原 Agent，且不持久化 PAT。
- **2026-11-25 新架构迁移**：实现由 Python（`coze_client.py`/`work_manager.py`/`app.py`）迁移至 TS 新架构，落点为 AgentEntity + KnowledgeEntryEntity，资源类型收敛为 **bot / dataset**（工作流本次不做，留待后续）。迁移提交 `1e7cc10`。旧实现记录见 01/02/03 分册的「新架构迁移说明」。
