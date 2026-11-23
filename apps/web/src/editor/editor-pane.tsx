import { createPortal } from 'react-dom';
import type { ProseMirrorNode } from '@storyforge/contracts';
import {
  canonicalizeContent,
  documentToMarkdown,
  markdownToDocument,
  replaceDocumentOperations
} from '@storyforge/editor-schema';
import { Button } from '@storyforge/ui';
import { useCallback, useEffect, useState } from 'react';
import { useEditorModeSlot } from './editor-mode-slot';
import { MarkdownEditor } from './markdown-editor';
import { ProseMirrorEditor } from './prosemirror-editor';
import type { ChapterRoleMarkNotice, RoleMark } from './role-marks';

export interface EditorPaneProps {
  initialDocument: ProseMirrorNode;
  readOnly: boolean;
  onDocument(operations: Array<Record<string, unknown>>, document: ProseMirrorNode): void;
  onMarkdownDraft(source: string): Promise<void>;
  roleMarks?: RoleMark[] | undefined;
  chapterMarks?: ChapterRoleMarkNotice[] | undefined;
  onDismissMark?: ((mark: RoleMark) => void) | undefined;
}

export function EditorPane({
  initialDocument, readOnly, onDocument, onMarkdownDraft, roleMarks, chapterMarks, onDismissMark
}: EditorPaneProps) {
  const modeSlot = useEditorModeSlot();
  const [document, setDocument] = useState(initialDocument);
  const [mode, setMode] = useState<'rich' | 'markdown'>('rich');
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  useEffect(() => setDocument(initialDocument), [initialDocument]);

  const commit = useCallback((next: ProseMirrorNode) => {
    // Markdown 往返会重建 pid，内容比较忽略 pid，避免无文字变化也产生替换操作
    if (canonicalizeContent(next) === canonicalizeContent(document)) { setError(''); return; }
    const operations = replaceDocumentOperations(document, next);
    setDocument(next); setError(''); onDocument(operations, next);
  }, [document, onDocument]);

  useEffect(() => {
    if (mode !== 'markdown' || readOnly) return;
    const timer = setTimeout(() => {
      try { commit(markdownToDocument(source)); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Markdown 解析失败'); }
    }, 500);
    return () => clearTimeout(timer);
  }, [commit, mode, readOnly, source]);

  function showMarkdown() {
    setSource(documentToMarkdown(document)); setError(''); setMode('markdown');
  }
  function showRich() {
    if (mode === 'rich') return;
    try { commit(markdownToDocument(source)); setMode('rich'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Markdown 解析失败'); }
  }
  function changeSource(next: string) {
    setSource(next);
    void onMarkdownDraft(next).catch((cause) => setError(cause instanceof Error ? cause.message : 'Markdown 草稿保存失败'));
  }

  const modeControl = <div role="group" aria-label="编辑模式" className="editor-mode-controls">
    {/* 需求3：选中/未选中视觉互换 —— 基础态统一 ghost（透明底灰字），选中态用翡翠绿 btn-mode-active 覆盖，
        所有 hover/active/选中/默认状态由 CSS 提供清晰反馈，切换流畅 */}
    <Button variant="ghost" size="sm" className={mode === 'rich' ? 'btn-mode-active' : undefined}
      aria-pressed={mode === 'rich'} onClick={showRich}>富文本</Button>
    <Button variant="ghost" size="sm" className={mode === 'markdown' ? 'btn-mode-active' : undefined}
      aria-pressed={mode === 'markdown'} onClick={showMarkdown}>Markdown</Button>
  </div>;

  return <section aria-label="正文编辑器">
    {modeSlot ? createPortal(modeControl, modeSlot) : modeControl}
    {mode === 'rich'
      ? <ProseMirrorEditor initialDocument={document} readOnly={readOnly} roleMarks={roleMarks}
          chapterMarks={chapterMarks} onDismissMark={onDismissMark} onDocument={(operations, next) => {
          setDocument(next); onDocument(operations, next);
        }} />
      : <MarkdownEditor source={source} readOnly={readOnly} error={error} onChange={changeSource}
          roleMarks={roleMarks} chapterMarks={chapterMarks} onDismissMark={onDismissMark} />}
  </section>;
}