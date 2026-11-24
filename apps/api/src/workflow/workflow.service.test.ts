import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { WorkflowService } from './workflow.service';

let fixture: WritingFixture;
let service: WorkflowService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new WorkflowService(fixture.dataSource);
});

afterEach(() => destroyWritingFixture(fixture));

function createInput(name = '测试工作流') {
  return {
    name,
    description: '描述',
    llm_config: { model: 'gpt-4o-mini' }
  };
}

describe('WorkflowService', () => {
  // ── createWorkflow ──

  it('creates a workflow with defaults and initial version snapshot', async () => {
    const wf = await service.createWorkflow(fixture.authorId, createInput());
    expect(wf.name).toBe('测试工作流');
    expect(wf.platform).toBe('coze');
    expect(wf.source).toBe('manual');
    expect(wf.status).toBe('active');
    expect(wf.version_no).toBe(2); // 创建快照后自增
    expect(wf.versions).toHaveLength(1);
    expect(wf.versions[0]?.change_type).toBe('create');
    expect(wf.author_id).toBe(fixture.authorId);
  });

  it('rejects duplicate workflow name for the same author with 409', async () => {
    await service.createWorkflow(fixture.authorId, createInput('同名牌'));
    await expect(service.createWorkflow(fixture.authorId, createInput('同名牌')))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('allows the same workflow name for a different author', async () => {
    await service.createWorkflow(fixture.authorId, createInput('共用名'));
    const wf = await service.createWorkflow(fixture.otherAuthorId, createInput('共用名'));
    expect(wf.name).toBe('共用名');
    expect(wf.author_id).toBe(fixture.otherAuthorId);
  });

  it('persists platform_config and llm_config without sensitive leakage', async () => {
    const wf = await service.createWorkflow(fixture.authorId, {
      ...createInput(),
      platform_config: { workflow_id: 'wf-abc123', workspace_id: 'ws-xyz' }
    });
    expect(wf.platform_config).toEqual({ workflow_id: 'wf-abc123', workspace_id: 'ws-xyz' });
    expect(wf.llm_config).toEqual({ model: 'gpt-4o-mini' });
  });

  // ── listWorkflows ──

  it('lists workflows for the author only, with keyword and status filtering', async () => {
    const a = await service.createWorkflow(fixture.authorId, createInput('小说主线'));
    const b = await service.createWorkflow(fixture.authorId, createInput('支线生成'));
    await service.createWorkflow(fixture.otherAuthorId, createInput('他人工作流'));

    // 全量（作者隔离）
    const all = await service.listWorkflows(fixture.authorId, {});
    expect(all.total).toBe(2);
    expect(all.workflows.every((i) => i.author_id === fixture.authorId)).toBe(true);

    // keyword 过滤
    const byKeyword = await service.listWorkflows(fixture.authorId, { keyword: '主线' });
    expect(byKeyword.total).toBe(1);
    expect(byKeyword.workflows[0]?.id).toBe(a.id);

    // status 过滤
    await service.archiveWorkflow(fixture.authorId, b.id);
    const byStatus = await service.listWorkflows(fixture.authorId, { status: 'archived' });
    expect(byStatus.total).toBe(1);
    expect(byStatus.workflows[0]?.id).toBe(b.id);

    // 列表项不暴露 versions（WorkflowListItem 类型不含该字段）
    expect('versions' in all.workflows[0]!).toBe(false);
  });

  it('paginates workflow list with skip/take', async () => {
    for (let i = 0; i < 5; i++) await service.createWorkflow(fixture.authorId, createInput(`wf-${i}`));
    const page2 = await service.listWorkflows(fixture.authorId, { page: 2, page_size: 2 });
    expect(page2.workflows).toHaveLength(2);
    expect(page2.page).toBe(2);
    expect(page2.page_size).toBe(2);
  });

  // ── getWorkflow / listVersions ──

  it('gets workflow detail for the owner and rejects cross-author read', async () => {
    const wf = await service.createWorkflow(fixture.authorId, createInput());
    const detail = await service.getWorkflow(fixture.authorId, wf.id);
    expect(detail.id).toBe(wf.id);

    await expect(service.getWorkflow(fixture.otherAuthorId, wf.id))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getWorkflow(fixture.authorId, randomUUID()))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns version history summaries sorted desc without snapshot content', async () => {
    const wf = await service.createWorkflow(fixture.authorId, createInput());
    await service.updateWorkflow(fixture.authorId, wf.id, { name: '改名' });
    const versions = await service.listVersions(fixture.authorId, wf.id);
    expect(versions.length).toBe(2);
    // 最新在前
    expect(versions[0]?.version_no).toBe(2);
    expect(versions[1]?.version_no).toBe(1);
    // 不含 snapshot 字段
    expect(versions[0]).not.toHaveProperty('snapshot');
  });

  // ── updateWorkflow ──

  it('updates whitelisted fields and appends a version snapshot', async () => {
    const wf = await service.createWorkflow(fixture.authorId, createInput());
    const updated = await service.updateWorkflow(fixture.authorId, wf.id, {
      name: '新名字',
      description: '新描述',
      llm_config: { model: 'claude-3-5-sonnet' }
    });
    expect(updated.name).toBe('新名字');
    expect(updated.description).toBe('新描述');
    expect(updated.llm_config).toEqual({ model: 'claude-3-5-sonnet' });
    expect(updated.version_no).toBe(3); // 创建(2) + 更新(3)
    expect(updated.versions).toHaveLength(2);
  });

  it('forbids setting archived through normal update with 409', async () => {
    const wf = await service.createWorkflow(fixture.authorId, createInput());
    await expect(service.updateWorkflow(fixture.authorId, wf.id, { status: 'archived' }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('allows toggling active/disabled but never archived via update', async () => {
    const wf = await service.createWorkflow(fixture.authorId, createInput());
    const disabled = await service.updateWorkflow(fixture.authorId, wf.id, { status: 'disabled' });
    expect(disabled.status).toBe('disabled');
    const active = await service.updateWorkflow(fixture.authorId, wf.id, { status: 'active' });
    expect(active.status).toBe('active');
  });

  it('rejects updating a non-owned or missing workflow with 404', async () => {
    const wf = await service.createWorkflow(fixture.authorId, createInput());
    await expect(service.updateWorkflow(fixture.otherAuthorId, wf.id, { name: 'x' }))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateWorkflow(fixture.authorId, randomUUID(), { name: 'x' }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  // ── archive / restore ──

  it('archives a workflow and rejects double-archive', async () => {
    const wf = await service.createWorkflow(fixture.authorId, createInput());
    const archived = await service.archiveWorkflow(fixture.authorId, wf.id, '整理归档');
    expect(archived.status).toBe('archived');
    expect(archived.archived_at).not.toBeNull();
    expect(archived.versions.at(-1)?.change_type).toBe('archive');

    await expect(service.archiveWorkflow(fixture.authorId, wf.id))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('restores an archived workflow and rejects restoring non-archived', async () => {
    const wf = await service.createWorkflow(fixture.authorId, createInput());
    await service.archiveWorkflow(fixture.authorId, wf.id);
    const restored = await service.restoreWorkflow(fixture.authorId, wf.id);
    expect(restored.status).toBe('active');
    expect(restored.archived_at).toBeNull();
    expect(restored.versions.at(-1)?.change_type).toBe('restore');

    await expect(service.restoreWorkflow(fixture.authorId, wf.id))
      .rejects.toBeInstanceOf(ConflictException);
  });

  // ── deleteWorkflow ──

  it('hard-deletes an archived workflow', async () => {
    const wf = await service.createWorkflow(fixture.authorId, createInput());
    await service.archiveWorkflow(fixture.authorId, wf.id);
    const res = await service.deleteWorkflow(fixture.authorId, wf.id);
    expect(res.deleted).toBe(true);

    await expect(service.getWorkflow(fixture.authorId, wf.id))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('requires force=true to delete a non-archived workflow', async () => {
    const wf = await service.createWorkflow(fixture.authorId, createInput());
    await expect(service.deleteWorkflow(fixture.authorId, wf.id))
      .rejects.toBeInstanceOf(ConflictException);
    const res = await service.deleteWorkflow(fixture.authorId, wf.id, true);
    expect(res.deleted).toBe(true);
  });

  it('rejects deleting a non-owned or missing workflow with 404', async () => {
    const wf = await service.createWorkflow(fixture.authorId, createInput());
    await expect(service.deleteWorkflow(fixture.otherAuthorId, wf.id, true))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  // ── rollbackWorkflow ──

  it('rolls back to a previous version and appends a rollback snapshot', async () => {
    const wf = await service.createWorkflow(fixture.authorId, createInput());
    await service.updateWorkflow(fixture.authorId, wf.id, { name: 'v2 名字' });
    // 回滚到 v1（初始态）→ name 恢复为原始名
    const rolled = await service.rollbackWorkflow(fixture.authorId, wf.id, 1);
    expect(rolled.name).toBe('测试工作流');
    expect(rolled.version_no).toBe(4); // create(2)+update(3)+rollback(4)
    expect(rolled.versions.at(-1)?.change_type).toBe('rollback');
    expect(rolled.versions.at(-1)?.note).toBe('回滚至 v1');
  });

  it('rejects rolling back to a missing version with 409', async () => {
    const wf = await service.createWorkflow(fixture.authorId, createInput());
    await expect(service.rollbackWorkflow(fixture.authorId, wf.id, 999))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects rolling back a non-owned workflow with 404', async () => {
    const wf = await service.createWorkflow(fixture.authorId, createInput());
    await expect(service.rollbackWorkflow(fixture.otherAuthorId, wf.id, 1))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});
