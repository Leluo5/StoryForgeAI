// ============================================================================
// M3c-3 知识库 · 引用面板（T34）
// 依据：docs/04-功能交付档案/M3c-3-知识库/03-任务规划.md T34 完成标准
//
// 覆盖：
//   - 引用列表渲染（标题 + 状态徽标）
//   - 失效快照标识（invalid → 失效引用（快照）；source_deleted → 来源已删除）
//   - 空态「暂无引用」非错误态
//   - 移除引用回调 onRemove(refId)
//   - 另存副本回调 onCopy(refId, { keep_ref })
//   - 副本成功提示
//   - loading / error 状态
// ============================================================================

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RefPanel } from './ref-panel';
import type { KnowledgeEntrySummary } from '@storyforge/contracts';

const workId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function ref(overrides: Partial<KnowledgeEntrySummary>): KnowledgeEntrySummary {
  return {
    kind: 'reference',
    id: '11111111-1111-4111-8111-111111111111',
    ref_id: 'ref-1',
    entry_type: 'article',
    title: '引用的文章',
    excerpt: '摘要',
    tags: [],
    structure_status: 'ready',
    favorite: false,
    pinned: false,
    ref_status: 'active',
    created_at: '2026-11-24T00:00:00.000Z',
    updated_at: '2026-11-24T00:00:00.000Z',
    ...overrides
  };
}

describe('RefPanel', () => {
  it('renders ref list with active badge', () => {
    render(<RefPanel workId={workId} refs={[ref({})]} />);
    expect(screen.getByText('引用的文章')).toBeInTheDocument();
    expect(screen.getByText('有效引用')).toBeInTheDocument();
  });

  it('marks source_deleted ref', () => {
    render(<RefPanel workId={workId} refs={[ref({ ref_status: 'source_deleted' })]} />);
    expect(screen.getByText('来源已删除')).toBeInTheDocument();
  });

  it('marks invalid ref with snapshot badge', () => {
    render(<RefPanel workId={workId} refs={[ref({ ref_status: 'invalid' })]} />);
    expect(screen.getByText('失效引用（快照）')).toBeInTheDocument();
  });

  it('shows empty state as non-error status', () => {
    render(<RefPanel workId={workId} refs={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent('暂无引用');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('calls onRemove with ref id', async () => {
    const onRemove = vi.fn();
    render(<RefPanel workId={workId} refs={[ref({})]} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole('button', { name: /移除引用/ }));
    expect(onRemove).toHaveBeenCalledWith('ref-1');
  });

  it('calls onCopy with ref id and keep_ref', async () => {
    const onCopy = vi.fn();
    render(<RefPanel workId={workId} refs={[ref({})]} onCopy={onCopy} />);
    await userEvent.click(screen.getByRole('button', { name: /另存副本/ }));
    expect(onCopy).toHaveBeenCalledWith('ref-1', { keep_ref: true });
  });

  it('shows copy success message', () => {
    render(<RefPanel workId={workId} refs={[ref({})]} copiedMessage="已另存副本，正在跳转…" />);
    expect(screen.getByRole('status')).toHaveTextContent('已另存副本');
  });

  it('shows error alert', () => {
    render(<RefPanel workId={workId} refs={[]} error="加载引用失败。" />);
    expect(screen.getByRole('alert')).toHaveTextContent('加载引用失败');
  });

  it('shows loading spinner', () => {
    render(<RefPanel workId={workId} refs={[]} loading />);
    expect(screen.getByText('正在加载引用…')).toBeInTheDocument();
  });
});
