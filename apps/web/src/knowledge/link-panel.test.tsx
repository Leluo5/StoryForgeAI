// ============================================================================
// M3c-3 知识库 · 关联面板（T34）
// 依据：docs/04-功能交付档案/M3c-3-知识库/03-任务规划.md T34 完成标准
//
// 覆盖：
//   - 自动关联展示相似度分数与「灵感相似匹配」徽标；手动关联展示「手动关联」
//   - 空态「暂无关联」为非错误态（role=status）
//   - 解除关联回调 onRemove(linkId)
//   - 手动关联选择目标条目并回调 onAdd(targetId)
//   - 自关联被拒（409 SELF_LINK）友好提示
//   - loading / error 状态
// ============================================================================

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LinkPanel } from './link-panel';
import type { KnowledgeEntrySummary, KnowledgeLink } from '@storyforge/contracts';

const entryId = '11111111-1111-4111-8111-111111111111';
const targetA = '22222222-2222-4222-8222-222222222222';
const targetB = '33333333-3333-4333-8333-333333333333';

function candidate(id: string, title: string): KnowledgeEntrySummary {
  return {
    kind: 'entry',
    id,
    entry_type: 'article',
    title,
    excerpt: '',
    tags: [],
    structure_status: 'ready',
    favorite: false,
    pinned: false,
    created_at: '2026-11-24T00:00:00.000Z',
    updated_at: '2026-11-24T00:00:00.000Z'
  };
}

const autoLink: KnowledgeLink = {
  id: 'link-1',
  source_entry_id: entryId,
  target_entry_id: targetA,
  kind: 'inspiration_auto',
  score: 0.87,
  source_title: '灵感条目',
  target_title: '相关论文',
  created_at: '2026-11-24T00:00:00.000Z'
};

const manualLink: KnowledgeLink = {
  id: 'link-2',
  source_entry_id: entryId,
  target_entry_id: targetB,
  kind: 'manual',
  source_title: '灵感条目',
  target_title: '手动设定',
  created_at: '2026-11-24T00:00:00.000Z'
};

describe('LinkPanel', () => {
  it('renders auto link with score and kind badge', () => {
    render(<LinkPanel entryId={entryId} links={[autoLink]} />);
    expect(screen.getByText('相关论文')).toBeInTheDocument();
    expect(screen.getByText('灵感相似匹配')).toBeInTheDocument();
    expect(screen.getByText('相似度 0.87')).toBeInTheDocument();
  });

  it('renders manual link with manual badge and no score', () => {
    render(<LinkPanel entryId={entryId} links={[manualLink]} />);
    expect(screen.getByText('手动设定')).toBeInTheDocument();
    expect(screen.getByText('手动关联')).toBeInTheDocument();
    expect(screen.queryByText(/相似度/)).not.toBeInTheDocument();
  });

  it('shows empty state as non-error status', () => {
    render(<LinkPanel entryId={entryId} links={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent('暂无关联');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('calls onRemove with the link id', async () => {
    const onRemove = vi.fn();
    render(<LinkPanel entryId={entryId} links={[autoLink]} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole('button', { name: /解除关联/ }));
    expect(onRemove).toHaveBeenCalledWith('link-1');
  });

  it('calls onAdd with the selected target id', async () => {
    const onAdd = vi.fn();
    render(
      <LinkPanel
        entryId={entryId}
        links={[]}
        onAdd={onAdd}
        candidates={[candidate(targetA, '候选条目')]}
      />
    );
    await userEvent.selectOptions(screen.getByLabelText('选择目标条目'), targetA);
    await userEvent.click(screen.getByRole('button', { name: '建立关联' }));
    expect(onAdd).toHaveBeenCalledWith(targetA);
  });

  it('shows self-link friendly error', () => {
    render(<LinkPanel entryId={entryId} links={[]} selfLinkError="不能关联自身条目。" />);
    expect(screen.getByRole('alert')).toHaveTextContent('不能关联自身条目');
  });

  it('shows loading spinner', () => {
    render(<LinkPanel entryId={entryId} links={[]} loading />);
    expect(screen.getByText('正在加载关联…')).toBeInTheDocument();
  });

  it('shows error alert', () => {
    render(<LinkPanel entryId={entryId} links={[]} error="加载关联失败。" />);
    expect(screen.getByRole('alert')).toHaveTextContent('加载关联失败');
  });

  it('fireEvent change works for select', () => {
    const onAdd = vi.fn();
    render(
      <LinkPanel
        entryId={entryId}
        links={[]}
        onAdd={onAdd}
        candidates={[candidate(targetA, '候选条目')]}
      />
    );
    const select = screen.getByLabelText('选择目标条目');
    fireEvent.change(select, { target: { value: targetA } });
    expect((select as HTMLSelectElement).value).toBe(targetA);
  });
});
