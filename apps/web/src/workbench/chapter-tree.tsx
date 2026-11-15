import { useState, type KeyboardEvent } from 'react';
import type { TreeResponse } from '@storyforge/contracts';
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

function titlePrompt(label: string, current = ''): string | undefined {
  const value = window.prompt(label, current)?.trim();
  return value ? value : undefined;
}

export function ChapterTree({ tree, currentChapterId, onOpen, onAction }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
      <button type="button" disabled={busy} onClick={() => {
        const title = titlePrompt('卷名称');
        if (title) void run({ type: 'create_volume', title });
      }}>新建卷</button>
    </div>
    {error && <p role="alert">{error}</p>}
    <ul role="tree" aria-label="卷章节">
      {[...tree.volumes].sort((a, b) => a.position - b.position).map((volume, volumeIndex) => {
        const chapters = tree.chapters.filter((chapter) => chapter.volume_id === volume.id)
          .sort((a, b) => a.position - b.position);
        return <li role="treeitem" aria-expanded="true" key={volume.id}>
          <div className="volume-row">
            <strong>{volume.title}</strong>
            <button type="button" aria-label={`重命名${volume.title}`} disabled={busy} onClick={() => {
              const title = titlePrompt('卷名称', volume.title);
              if (title) void run({ type: 'rename_volume', volumeId: volume.id, title });
            }}>重命名</button>
            <button type="button" aria-label={`上移${volume.title}`} disabled={busy || volumeIndex === 0}
              onClick={() => void run({ type: 'move_volume', volumeId: volume.id, direction: -1 })}>上移</button>
            <button type="button" aria-label={`下移${volume.title}`} disabled={busy || volumeIndex === tree.volumes.length - 1}
              onClick={() => void run({ type: 'move_volume', volumeId: volume.id, direction: 1 })}>下移</button>
            <button type="button" aria-label={`在${volume.title}新建章节`} disabled={busy} onClick={() => {
              const title = titlePrompt('章节名称');
              if (title) void run({ type: 'create_chapter', volumeId: volume.id, title }, true);
            }}>新建章节</button>
          </div>
          <ul role="group">
            {chapters.map((chapter, chapterIndex) => <li role="treeitem"
              aria-selected={chapter.id === currentChapterId} key={chapter.id}>
              <a data-chapter-link href={chapterUrl(tree.work.id, chapter.id)}
                tabIndex={chapter.id === currentChapterId ? 0 : -1}
                onKeyDown={moveFocus}
                onClick={(event) => {
                  // 保留浏览器原生新标签打开能力，普通点击由路由接管
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault(); onOpen(chapter.id);
                }}>{chapter.title}</a>
              <button type="button" aria-label={`重命名${chapter.title}`} disabled={busy} onClick={() => {
                const title = titlePrompt('章节名称', chapter.title);
                if (title) void run({ type: 'rename_chapter', chapterId: chapter.id, title });
              }}>重命名</button>
              <button type="button" aria-label={`上移${chapter.title}`} disabled={busy || chapterIndex === 0}
                onClick={() => void run({ type: 'move_chapter', volumeId: volume.id, chapterId: chapter.id, direction: -1 })}>上移</button>
              <button type="button" aria-label={`下移${chapter.title}`} disabled={busy || chapterIndex === chapters.length - 1}
                onClick={() => void run({ type: 'move_chapter', volumeId: volume.id, chapterId: chapter.id, direction: 1 })}>下移</button>
            </li>)}
          </ul>
        </li>;
      })}
    </ul>
  </nav>;
}
