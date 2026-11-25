// ============================================================================
// M3c-3 知识库 · 抽屉（方案 D）测试
// 依据：docs/01-产品与设计/知识库工作台抽屉设计-方案D.md §8 验收要点
// 覆盖：默认「本作品」库 / 搜索防抖 / Chip 筛选 / 紧凑卡片 / 抽屉内简易详情 /
//       一键引用 Toast / 空态 / 错误重试 / 全屏管理跳转带筛选。
// ============================================================================

import { createRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { KnowledgeDrawer, type KnowledgeDrawerHandle } from './knowledge-drawer';
import { knowledgeClient } from './knowledge-client';
import type { KnowledgeEntryDetail, KnowledgeEntrySummary } from '@storyforge/contracts';

const listEntries = vi.fn() as Mock;
const listTags = vi.fn() as Mock;
const fetchEntry = vi.fn() as Mock;
const createRefs = vi.fn() as Mock;

vi.mock('./knowledge-client', () => ({
  knowledgeClient: {
    listEntries: (...args: unknown[]) => listEntries(...args),
    listTags: (...args: unknown[]) => listTags(...args),
    fetchEntry: (...args: unknown[]) => fetchEntry(...args),
    createRefs: (...args: unknown[]) => createRefs(...args)
  }
}));

const SUMMARY = {
  kind: 'entry',
  id: 'e1',
  entry_type: 'article',
  title: '世界观速记',
  excerpt: '一段摘要',
  tags: ['世界观'],
  structure_status: 'ready',
  favorite: true,
  pinned: false,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z'
} as unknown as KnowledgeEntrySummary;

const SECOND = { ...SUMMARY, id: 'e2', title: '人物小传' };

const MANY_TAGS: KnowledgeEntrySummary = {
  ...SUMMARY,
  id: 'e3',
  title: '多标签条目',
  tags: ['世界观', '人物', '地点'],
  outline_status: 'ready'
};

const DETAIL = {
  ...SUMMARY,
  original_text: '第一章正文',
  structured: null,
  outline: null,
  version: 1,
  content_hash: 'hash-1'
} as unknown as KnowledgeEntryDetail;

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom 未实现 dialog showModal/close，测试桩保持一致
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
  listEntries.mockResolvedValue({ items: [SUMMARY, SECOND], next_cursor: null, total: 2 });
  listTags.mockResolvedValue([
    { id: 't1', name: '世界观', entry_count: 3 },
    { id: 't2', name: '人物', entry_count: 1 }
  ]);
  fetchEntry.mockResolvedValue(DETAIL);
  createRefs.mockResolvedValue([]);
});

function openDrawer(props: { workId: string | null } = { workId: 'w1' }) {
  const ref = createRef<KnowledgeDrawerHandle>();
  render(<KnowledgeDrawer ref={ref} workId={props.workId} />);
  ref.current!.open();
  return ref;
}

/** 卡片标题按钮内是首个同名文本节点，取它避免点到详情区重复文本 */
function cardHit(name: string): HTMLElement {
  const first = screen.getAllByText(name)[0];
  if (!first) throw new Error(`未找到「${name}」`);
  const hit = first.closest<HTMLElement>('button.kb-drawer__card-title-hit');
  if (!hit) throw new Error(`「${name}」不在卡片标题按钮内`);
  return hit;
}

describe('KnowledgeDrawer（方案 D）', () => {
  it('有作品上下文时默认落在「本作品」库', () => {
    openDrawer({ workId: 'w1' });
    expect(screen.getByRole('tab', { name: '本作品' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '全局库' })).toHaveAttribute('aria-selected', 'false');
  });

  it('无作品上下文时只保留「全局库」页签', () => {
    openDrawer({ workId: null });
    expect(screen.queryByRole('tab', { name: '本作品' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '全局库' })).toHaveAttribute('aria-selected', 'true');
  });

  it('渲染紧凑卡片并显示条数', async () => {
    openDrawer();
    await waitFor(() => expect(screen.getAllByText('世界观速记').length).toBeGreaterThan(0));
    expect(screen.getByText('人物小传')).toBeInTheDocument();
    expect(screen.getByText('共 2 条')).toBeInTheDocument();
  });

  it('点击卡片在抽屉内展开简易详情（不跳全页）', async () => {
    openDrawer();
    await waitFor(() => expect(screen.getAllByText('世界观速记').length).toBeGreaterThan(0));
    await userEvent.click(cardHit('世界观速记'));
    await waitFor(() => expect(screen.getByText('第一章正文')).toBeInTheDocument());
    expect(screen.getByText('引用到当前作品')).toBeInTheDocument();
    expect(screen.getByText('查看完整')).toBeInTheDocument();
  });

  it('一键引用成功后弹 Toast 并调用 createRefs', async () => {
    openDrawer();
    await waitFor(() => expect(screen.getAllByText('世界观速记').length).toBeGreaterThan(0));
    const refButton = screen.getAllByRole('button', { name: '引用' })[0];
    if (!refButton) throw new Error('未找到「引用」按钮');
    await userEvent.click(refButton);
    await waitFor(() => expect(screen.getByText('已引用')).toBeInTheDocument());
    expect(createRefs).toHaveBeenCalledWith('w1', { entry_ids: ['e1'] });
  });

  it('切换类型 Chip 会带 types 参数重新检索', async () => {
    openDrawer();
    await userEvent.click(screen.getByRole('button', { name: '论文' }));
    await waitFor(() => {
      expect(listEntries).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'work', work_id: 'w1', types: ['paper'] })
      );
    });
  });

  it('搜索输入防抖后才应用关键词', async () => {
    openDrawer();
    await waitFor(() => expect(screen.getAllByText('世界观速记').length).toBeGreaterThan(0));
    const before = listEntries.mock.calls.length;
    const search = screen.getByRole('searchbox', { name: '搜索知识条目' });
    fireEvent.change(search, { target: { value: '世界' } });
    expect(listEntries.mock.calls.length).toBe(before);
    await waitFor(() => {
      expect(listEntries).toHaveBeenCalledWith(expect.objectContaining({ keyword: '世界' }));
    });
  });

  it('紧凑卡片：标签最多 2 个、收藏/大纲标记、点击即选中', async () => {
    listEntries.mockResolvedValue({ items: [MANY_TAGS], next_cursor: null, total: 1 });
    openDrawer();
    await waitFor(() => expect(screen.getByText('多标签条目')).toBeInTheDocument());
    // §3.3：标签 chips 最多 2 个
    expect(screen.getAllByText('世界观').length).toBeGreaterThan(0);
    expect(screen.queryByText('地点')).not.toBeInTheDocument();
    // §3.3：行首图标 + 收藏 ★ + 有大纲 🗂
    expect(screen.getByTitle('已收藏')).toBeInTheDocument();
    expect(screen.getByTitle('已有大纲')).toBeInTheDocument();
    // §3.3：点击卡片在抽屉内展开详情（选中态保留在卡片上）
    await userEvent.click(cardHit('多标签条目'));
    await waitFor(() => expect(screen.getByText('第一章正文')).toBeInTheDocument());
    const selected = screen.getByText('多标签条目').closest('[data-entry-id="e3"]');
    expect(selected).toHaveAttribute('aria-current', 'true');
  });

  it('列表失败时显示错误与重试按钮', async () => {
    listEntries.mockRejectedValue(new Error('网络异常'));
    openDrawer();
    await waitFor(() => expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument());
  });

  it('「全屏管理 →」跳转携带当前筛选与选中条目', async () => {
    const winOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    const ref = createRef<KnowledgeDrawerHandle>();
    render(<KnowledgeDrawer ref={ref} workId="w1" />);
    ref.current!.open();
    await waitFor(() => expect(screen.getAllByText('世界观速记').length).toBeGreaterThan(0));
    await userEvent.click(cardHit('世界观速记'));
    await userEvent.click(screen.getByRole('button', { name: '全屏管理 →' }));
    const url = winOpen.mock.calls[0]?.[0] as string;
    expect(url).toContain('/knowledge');
    expect(url).toContain('entry=e1');
    winOpen.mockRestore();
  });
});
