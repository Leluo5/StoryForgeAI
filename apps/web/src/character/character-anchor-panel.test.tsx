import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  ArchiveScan,
  ArchiveScanStatus,
  ChapterParagraphMark,
  ChapterRoleMarks
} from '@storyforge/contracts';
import type { CharacterAnchorClient } from './character-anchor-client';
import { CharacterAnchorPanel } from './character-anchor-panel';

const workId = '11111111-1111-4111-8111-111111111111';
const characterId = '22222222-2222-4222-8222-222222222222';
const chapter1 = '33333333-3333-4333-8333-333333333333';
const chapter2 = '44444444-4444-4444-8444-444444444444';
const chapter3 = '55555555-5555-4555-8555-555555555555';

function uid(seed: number): string {
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;
}

function makeMark(seed: number, overrides: Partial<ChapterParagraphMark> = {}): ChapterParagraphMark {
  return {
    id: uid(seed),
    character_id: uid(900),
    character_name: '林墨',
    paragraph_pid: uid(500 + seed),
    matched_name: '林墨',
    status: 'active',
    excerpt: '他在雪夜拔剑。',
    ...overrides
  };
}

function marksResponse(
  paragraphMarks: ChapterParagraphMark[],
  status: ArchiveScanStatus = 'succeeded'
): ChapterRoleMarks {
  return {
    paragraph_marks: paragraphMarks,
    chapter_marks: [],
    scan: { status, scanned_chapters: 5, total_chapters: 5 }
  };
}

function makeScan(status: ArchiveScanStatus, scanned = 0, total = 5): ArchiveScan {
  return {
    id: uid(77),
    character_id: uid(900),
    status,
    total_chapters: total,
    scanned_chapters: scanned,
    matched_paragraphs: 0,
    error: null,
    created_at: '2026-01-01T00:00:00.000Z'
  };
}

function makeAnchors(overrides: Partial<CharacterAnchorClient> = {}): CharacterAnchorClient {
  const base = {
    getChapterRoleMarks: vi.fn(async () => marksResponse([])),
    dismissAnchor: vi.fn(async () => ({ anchor_id: uid(1), dismissed: true })),
    dismissAnchorsBatch: vi.fn(async () => ({ dismissed: 1 })),
    rescanArchive: vi.fn(async () => ({ scan: makeScan('succeeded', 5, 5) }))
  };
  return { ...base, ...overrides } as unknown as CharacterAnchorClient;
}

const chapters = [
  { id: chapter1, title: '第一章 初遇' },
  { id: chapter2, title: '第二章 夜行' }
];

describe('CharacterAnchorPanel T38', () => {
  it('未选择章节时展示空态且不发起请求', async () => {
    const anchors = makeAnchors();
    render(<CharacterAnchorPanel workId={workId} characterId={characterId} anchorClient={anchors} />);

    expect(await screen.findByText('需要先选择章节')).toBeVisible();
    expect(anchors.getChapterRoleMarks).not.toHaveBeenCalled();
    expect(screen.getByText('选择章节后可统计命中段落与章节级提示。')).toBeVisible();
  });

  it('命中段落展示章节名 + 摘录 + 命中名称，并按已读数据统计影响', async () => {
    const m1 = makeMark(1, { matched_name: '林墨', excerpt: '他在雪夜拔剑。' });
    const m2 = makeMark(2, { matched_name: '沈星河', excerpt: '星河落尽。' });
    const anchors = makeAnchors({
      getChapterRoleMarks: vi.fn(async (_workId: string, chapterId: string) =>
        chapterId === chapter1 ? marksResponse([m1]) : marksResponse([m2])
      )
    });
    render(
      <CharacterAnchorPanel
        workId={workId}
        characterId={characterId}
        anchorClient={anchors}
        chapters={chapters}
        chapterIds={[chapter1, chapter2]}
      />
    );

    expect(await screen.findByText('第一章 初遇')).toBeVisible();
    expect(screen.getByText('他在雪夜拔剑。')).toBeVisible();
    expect(screen.getByText('命中：林墨')).toBeVisible();
    expect(screen.getByText('第二章 夜行')).toBeVisible();
    expect(screen.getByText('命中：沈星河')).toBeVisible();
    expect(anchors.getChapterRoleMarks).toHaveBeenCalledWith(workId, chapter1);
    expect(anchors.getChapterRoleMarks).toHaveBeenCalledWith(workId, chapter2);

    // 扫描状态来自已读章节的 scan：succeeded 才显示「已完成」
    expect(await screen.findByText(/已完成/)).toBeVisible();
    expect(screen.getByText(/命中段落 2 条，覆盖 2 章/)).toBeVisible();

    // 键盘可达：原生复选框 + 可 Tab 的按钮
    expect(screen.getByLabelText('全选命中段落')).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByRole('button', { name: '反选' })).toBeEnabled();
  });

  it('外部传入 impact 时优先展示该摘要', async () => {
    const anchors = makeAnchors();
    render(
      <CharacterAnchorPanel
        workId={workId}
        characterId={characterId}
        anchorClient={anchors}
        chapterIds={[chapter1]}
        impact={{ relations: 3, growth_events: 2, chapters: 4, exclusive_plot_nodes: 1 }}
      />
    );

    expect(
      await screen.findByText('归档影响：关系 3 条、成长事件 2 个、涉及章节 4 章、专属剧情节点 1 个。')
    ).toBeVisible();
  });

  it('扫描中不显示已完成，并展示扫描进度', async () => {
    const anchors = makeAnchors({
      getChapterRoleMarks: vi.fn(async () => marksResponse([])),
      rescanArchive: vi.fn(async () => ({ scan: makeScan('pending', 0, 5) }))
    });
    render(
      <CharacterAnchorPanel
        workId={workId}
        characterId={characterId}
        anchorClient={anchors}
        chapterIds={[chapter1]}
      />
    );

    await screen.findByText('尚未扫描');
    fireEvent.click(screen.getByRole('button', { name: '立即扫描' }));

    await waitFor(() => expect(screen.getByText(/扫描中 · 进度 0\/5 章/)).toBeVisible());
    expect(screen.queryByText(/已完成/)).toBeNull();
    expect(anchors.rescanArchive).toHaveBeenCalledWith(workId, characterId);
  });

  it('扫描失败展示失败态与重试，重试重新发起扫描', async () => {
    const rescanArchive = vi
      .fn()
      .mockRejectedValueOnce(new Error('扫描服务不可用'))
      .mockResolvedValueOnce({ scan: makeScan('succeeded', 5, 5) });
    const anchors = makeAnchors({ rescanArchive });
    render(
      <CharacterAnchorPanel
        workId={workId}
        characterId={characterId}
        anchorClient={anchors}
        chapterIds={[chapter1]}
      />
    );

    await screen.findByText('尚未扫描');
    fireEvent.click(screen.getByRole('button', { name: '立即扫描' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('扫描服务不可用');
    expect(screen.getByText(/扫描失败 · 进度/)).toBeVisible();
    expect(screen.queryByText(/已完成/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByText(/已完成/)).toBeVisible());
    expect(rescanArchive).toHaveBeenCalledTimes(2);
  });

  it('单条剔除后立即移除并显示「已剔除 1 条」', async () => {
    const m1 = makeMark(1, { matched_name: '林墨', excerpt: '他在雪夜拔剑。' });
    const m2 = makeMark(2, { matched_name: '沈星河', excerpt: '星河落尽。' });
    const dismissAnchor = vi.fn(async () => ({ anchor_id: m1.id, dismissed: true as const }));
    const anchors = makeAnchors({
      getChapterRoleMarks: vi.fn(async (_workId: string, chapterId: string) =>
        chapterId === chapter1 ? marksResponse([m1]) : marksResponse([m2])
      ),
      dismissAnchor
    });
    const onDismissed = vi.fn();
    render(
      <CharacterAnchorPanel
        workId={workId}
        characterId={characterId}
        anchorClient={anchors}
        chapters={chapters}
        chapterIds={[chapter1, chapter2]}
        onDismissed={onDismissed}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: '剔除命中：林墨' }));

    expect(await screen.findByText('已剔除 1 条')).toBeVisible();
    expect(dismissAnchor).toHaveBeenCalledWith(workId, chapter1, m1.id);
    expect(screen.queryByText('他在雪夜拔剑。')).toBeNull();
    expect(screen.getByText('星河落尽。')).toBeVisible();
    expect(onDismissed).toHaveBeenCalledTimes(1);
  });

  it('全选后批量剔除按章节分别提交，并显示已剔除总数', async () => {
    const m1 = makeMark(1, { matched_name: '林墨', excerpt: '他在雪夜拔剑。' });
    const m2 = makeMark(2, { matched_name: '沈星河', excerpt: '星河落尽。' });
    const dismissAnchorsBatch = vi.fn(async () => ({ dismissed: 1 }));
    const anchors = makeAnchors({
      getChapterRoleMarks: vi.fn(async (_workId: string, chapterId: string) =>
        chapterId === chapter1 ? marksResponse([m1]) : marksResponse([m2])
      ),
      dismissAnchorsBatch
    });
    const onDismissed = vi.fn();
    render(
      <CharacterAnchorPanel
        workId={workId}
        characterId={characterId}
        anchorClient={anchors}
        chapters={chapters}
        chapterIds={[chapter1, chapter2]}
        onDismissed={onDismissed}
      />
    );

    fireEvent.click(await screen.findByLabelText('全选命中段落'));
    const batchButton = screen.getByRole('button', { name: '批量剔除（2）' });
    expect(batchButton).toBeEnabled();
    fireEvent.click(batchButton);

    expect(await screen.findByText('已剔除 2 条')).toBeVisible();
    expect(dismissAnchorsBatch).toHaveBeenCalledTimes(2);
    expect(dismissAnchorsBatch).toHaveBeenCalledWith(workId, chapter1, [m1.id]);
    expect(dismissAnchorsBatch).toHaveBeenCalledWith(workId, chapter2, [m2.id]);
    expect(screen.queryByText('他在雪夜拔剑。')).toBeNull();
    expect(screen.queryByText('星河落尽。')).toBeNull();
    expect(screen.getByText('当前章节暂无命中段落。')).toBeVisible();
    expect(onDismissed).toHaveBeenCalledTimes(1);
  });

  it('反选把未选中的标记为选中', async () => {
    const m1 = makeMark(1, { matched_name: '林墨', excerpt: '他在雪夜拔剑。' });
    const m2 = makeMark(2, { matched_name: '沈星河', excerpt: '星河落尽。' });
    const anchors = makeAnchors({
      getChapterRoleMarks: vi.fn(async (_workId: string, chapterId: string) =>
        chapterId === chapter1 ? marksResponse([m1]) : marksResponse([m2])
      )
    });
    render(
      <CharacterAnchorPanel
        workId={workId}
        characterId={characterId}
        anchorClient={anchors}
        chapters={chapters}
        chapterIds={[chapter1, chapter2]}
      />
    );

    fireEvent.click(await screen.findByLabelText(/选择 第一章 初遇/));
    expect(screen.getByRole('button', { name: '批量剔除（1）' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '反选' }));
    expect(screen.getByRole('button', { name: '批量剔除（1）' })).toBeEnabled();

    const checks = screen.getAllByRole('checkbox');
    // 反选后原选中的第一条变为未选中，未选中的第二条变为选中
    expect((checks[1] as HTMLInputElement).checked).toBe(false);
    expect((checks[2] as HTMLInputElement).checked).toBe(true);
  });

  it('加载失败展示 alert，可重新加载恢复', async () => {
    let attempt = 0;
    const m1 = makeMark(1);
    const anchors = makeAnchors({
      getChapterRoleMarks: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('命中段落读取失败');
        return marksResponse([m1]);
      })
    });
    render(
      <CharacterAnchorPanel
        workId={workId}
        characterId={characterId}
        anchorClient={anchors}
        chapters={chapters}
        chapterIds={[chapter1]}
      />
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('命中段落读取失败');
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));

    expect(await screen.findByText('命中：林墨')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('章节名无法解析时降级显示 id 前 8 位且不报错', async () => {
    const m1 = makeMark(1, { excerpt: '风起。' });
    const anchors = makeAnchors({
      getChapterRoleMarks: vi.fn(async () => marksResponse([m1]))
    });
    render(
      <CharacterAnchorPanel
        workId={workId}
        characterId={characterId}
        anchorClient={anchors}
        chapterIds={[chapter3]}
      />
    );

    expect(await screen.findByText(chapter3.slice(0, 8))).toBeVisible();
    expect(screen.getByText('风起。')).toBeVisible();
  });
});
