// ============================================================================
// M3c-3 知识库 · 回收站视图（T35）
// 依据：docs/04-功能交付档案/M3c-3-知识库/03-任务规划.md T35 完成标准
//
// 覆盖：
//   - 软删列表渲染（标题 + 删除时间）
//   - 空态「回收站为空」非错误态
//   - 恢复回调 onRestore(entryId)
//   - 彻底删除需二次确认（confirm=true）：先出现确认弹层，再确认才回调
//   - 恢复冲突 409 提示「条目已被更新，先处理冲突」
//   - 错误 role=alert；loading
// ============================================================================

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TrashView } from './trash-view';
import type { KnowledgeEntrySummary } from '@storyforge/contracts';

const entryId = '11111111-1111-4111-8111-111111111111';

function item(overrides: Partial<KnowledgeEntrySummary> = {}): KnowledgeEntrySummary {
  return {
    kind: 'entry',
    id: entryId,
    entry_type: 'article',
    title: '已删除的文章',
    excerpt: '摘要',
    tags: [],
    structure_status: 'ready',
    favorite: false,
    pinned: false,
    created_at: '2026-11-20T00:00:00.000Z',
    updated_at: '2026-11-22T00:00:00.000Z',
    ...overrides
  };
}

describe('TrashView', () => {
  it('renders soft-deleted list', () => {
    render(<TrashView items={[item()]} />);
    expect(screen.getByText('已删除的文章')).toBeInTheDocument();
  });

  it('shows empty state as non-error status', () => {
    render(<TrashView items={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent('回收站为空');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('calls onRestore with entry id', async () => {
    const onRestore = vi.fn();
    render(<TrashView items={[item()]} onRestore={onRestore} />);
    await userEvent.click(screen.getByRole('button', { name: /恢复/ }));
    expect(onRestore).toHaveBeenCalledWith(entryId);
  });

  it('requires confirm before purge', async () => {
    const onPurge = vi.fn();
    render(<TrashView items={[item()]} onPurge={onPurge} />);
    await userEvent.click(screen.getByRole('button', { name: /彻底删除/ }));
    expect(screen.getByRole('dialog')).toHaveTextContent('确认彻底删除');
    expect(onPurge).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(onPurge).toHaveBeenCalledWith(entryId, { confirm: true });
  });

  it('cancels purge confirm', async () => {
    const onPurge = vi.fn();
    render(<TrashView items={[item()]} onPurge={onPurge} />);
    await userEvent.click(screen.getByRole('button', { name: /彻底删除/ }));
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onPurge).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows restore conflict hint', () => {
    render(<TrashView items={[item()]} restoreError="条目已被更新，先处理冲突。" />);
    expect(screen.getByRole('alert')).toHaveTextContent('条目已被更新');
  });

  it('shows error alert', () => {
    render(<TrashView items={[]} error="加载回收站失败。" />);
    expect(screen.getByRole('alert')).toHaveTextContent('加载回收站失败');
  });

  it('shows loading spinner', () => {
    render(<TrashView items={[]} loading />);
    expect(screen.getByText('正在加载回收站…')).toBeInTheDocument();
  });
});
