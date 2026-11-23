import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { TreeResponse } from '@storyforge/contracts';
import { Button } from '@storyforge/ui';
import { chapterUrl } from './chapter-url';

export type TreeAction =
  | { type: 'create_volume'; title: string }
  | { type: 'rename_volume'; volumeId: string; title: string }
  | { type: 'move_volume'; volumeId: string; direction: -1 | 1 }
  | { type: 'create_chapter'; volumeId: string; title: string }
  | { type: 'rename_chapter'; chapterId: string; title: string }
  | { type: 'move_chapter'; volumeId: string; chapterId: string; direction: -1 | 1 };

interface Props {
  tree: TreeResponse;
  currentChapterId: string;
  onOpen(chapterId: string): void;
  onAction(action: TreeAction): Promise<string | undefined>;
}

/** 新建章节图标（加号） */
const PLUS_ICON = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

function titlePrompt(label: string, current = ''): string | undefined {
  const value = window.prompt(label, current)?.trim();
  return value ? value : undefined;
}

/** 字数格式化：千分位 + 「字」，如 1,234 字。未提供时按 0 兜底。 */
function formatWords(count?: number): string {
  return `${(count ?? 0).toLocaleString('zh-CN')} 字`;
}

/** 右键菜单项定义：run 内部完成「输入标题 → 派发 TreeAction」 */
interface MenuItem { label: string; disabled?: boolean; run(): void | Promise<void> }

/** 菜单定位：越界时收回到视口内 */
function clampPosition(x: number, y: number): { left: number; top: number } {
  const width = 140;
  const height = 104;
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - height - 8))
  };
}

export function ChapterTree({ tree, currentChapterId, onOpen, onAction }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState<{ left: number; top: number; items: MenuItem[] } | undefined>(undefined);

  async function run(action: TreeAction, navigate = false): Promise<void> {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const createdId = await onAction(action);
      if (navigate && createdId) onOpen(createdId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '章节操作失败');
    } finally {
      setBusy(false);
    }
  }

  function createChapter(volumeId: string): void {
    const title = titlePrompt('章节名称');
    if (title) void run({ type: 'create_chapter', volumeId, title }, true);
  }
  function renameVolume(volumeId: string, current: string): void {
    const title = titlePrompt('卷名称', current);
    if (title) void run({ type: 'rename_volume', volumeId, title });
  }
  function renameChapter(chapterId: string, current: string): void {
    const title = titlePrompt('章节名称', current);
    if (title) void run({ type: 'rename_chapter', chapterId, title });
  }

  function openMenu(event: MouseEvent, items: MenuItem[]): void {
    event.preventDefault();
    const { left, top } = clampPosition(event.clientX, event.clientY);
    setMenu({ left, top, items });
  }

  // 树内方向键漫游：只移动焦点，不触发导航
  function moveFocus(event: KeyboardEvent<HTMLAnchorElement>): void {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const links = Array.from(event.currentTarget.closest('[role="tree"]')?.querySelectorAll<HTMLAnchorElement>('[data-chapter-link]') ?? []);
    const index = links.indexOf(event.currentTarget);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1
      : event.key === 'ArrowDown' ? Math.min(links.length - 1, index + 1) : Math.max(0, index - 1);
    links[nextIndex]?.focus();
  }

  return <nav aria-label="作品结构">
    <div className="tree-actions">
      <Button size="sm" block disabled={busy} onClick={() => {
        const title = titlePrompt('卷名称');
        if (title) void run({ type: 'create_volume', title });
      }}>新建卷</Button>
    </div>
    {error && <p role="alert">{error}</p>}
    <ul role="tree" aria-label="卷章节">
      {[...tree.volumes].sort((a, b) => a.position - b.position).map((volume, volumeIndex) => {
        const chapters = tree.chapters.filter((chapter) => chapter.volume_id === volume.id)
          .sort((a, b) => a.position - b.position);
        // 卷字数汇总：该卷下各章字数之和（需求7，旧数据缺失按 0 兜底）
        const volumeWords = chapters.reduce((sum, chapter) => sum + (chapter.word_count ?? 0), 0);
        return <li role="treeitem" aria-expanded="true" key={volume.id}>
          {/* 卷行：名称渐隐截断（悬停 title 看全文）+ 字数（右对齐）+ 右侧加号新建章节（悬停显示，需求6）；
              重命名/上下移收进右键菜单 */}
          <div className="volume-row" onContextMenu={(event) => openMenu(event, [
            { label: '新建章节', run: () => createChapter(volume.id) },
            { label: '重命名卷', run: () => renameVolume(volume.id, volume.title) },
            { label: '上移', run: () => run({ type: 'move_volume', volumeId: volume.id, direction: -1 }), disabled: volumeIndex === 0 },
            { label: '下移', run: () => run({ type: 'move_volume', volumeId: volume.id, direction: 1 }), disabled: volumeIndex === tree.volumes.length - 1 }
          ])}>
            <strong className="fade-truncate" title={volume.title}>{volume.title}</strong>
            <span className="tree-word-count" title={`本卷共 ${formatWords(volumeWords)}`}>{formatWords(volumeWords)}</span>
            <Button className="tree-add" size="sm" variant="ghost" aria-label={`在${volume.title}新建章节`}
              disabled={busy} onClick={() => createChapter(volume.id)}>{PLUS_ICON}</Button>
          </div>
          <ul role="group">
            {chapters.map((chapter, chapterIndex) => <li role="treeitem" className="chapter-item"
              aria-selected={chapter.id === currentChapterId} key={chapter.id}
              onContextMenu={(event) => openMenu(event, [
                { label: '重命名章节', run: () => renameChapter(chapter.id, chapter.title) },
                { label: '上移', run: () => run({ type: 'move_chapter', volumeId: volume.id, chapterId: chapter.id, direction: -1 }), disabled: chapterIndex === 0 },
                { label: '下移', run: () => run({ type: 'move_chapter', volumeId: volume.id, chapterId: chapter.id, direction: 1 }), disabled: chapterIndex === chapters.length - 1 }
              ])}>
              <a data-chapter-link className="fade-truncate" title={chapter.title} href={chapterUrl(tree.work.id, chapter.id)}
                tabIndex={chapter.id === currentChapterId ? 0 : -1}
                onKeyDown={moveFocus}
                onClick={(event) => {
                  // 保留浏览器原生新标签打开能力，普通点击由路由接管
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault(); onOpen(chapter.id);
                }}>{chapter.title}</a>
              {/* 需求7：章节字数，右对齐，宽度不足时章名渐隐截断、字数保证全显 */}
              <span className="tree-word-count" title={`本章 ${formatWords(chapter.word_count)}`}>{formatWords(chapter.word_count)}</span>
            </li>)}
          </ul>
        </li>;
      })}
    </ul>
    {menu && <div className="tree-menu" role="menu" aria-label="章节操作"
      style={{ left: menu.left, top: menu.top }}
      onMouseDown={(event) => event.preventDefault()}
      onBlur={() => setMenu(undefined)}>
      {menu.items.map((item, index) => <button
        type="button" key={index} role="menuitem" disabled={item.disabled || busy}
        tabIndex={index === 0 ? 0 : -1}
        onClick={() => { void item.run(); setMenu(undefined); }}
      >{item.label}</button>)}
    </div>}
  </nav>;
}