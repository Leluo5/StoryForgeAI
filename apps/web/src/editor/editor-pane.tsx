import type { ProseMirrorNode } from '@storyforge/contracts';
import {
  canonicalizeDocument,
  documentToMarkdown,
  markdownToDocument,
  replaceDocumentOperations
} from '@storyforge/editor-schema';
import { useCallback, useEffect, useState } from 'react';
import { MarkdownEditor } from './markdown-editor';
import { ProseMirrorEditor } from './prosemirror-editor';

export interface EditorPaneProps {
  initialDocument: ProseMirrorNode;
  readOnly: boolean;
  onDocument(operations: Array<Record<string, unknown>>, document: ProseMirrorNode): void;
  onMarkdownDraft(source: string): Promise<void>;
}

export function EditorPane({ initialDocument, readOnly, onDocument, onMarkdownDraft }: EditorPaneProps) {
  const [document, setDocument] = useState(initialDocument);
  const [mode, setMode] = useState<'rich' | 'markdown'>('rich');
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  useEffect(() => setDocument(initialDocument), [initialDocument]);

  const commit = useCallback((next: ProseMirrorNode) => {
    if (canonicalizeDocument(next) === canonicalizeDocument(document)) { setError(''); return; }
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

  return <section aria-label="正文编辑器">
    <div role="group" aria-label="编辑模式">
      <button type="button" aria-pressed={mode === 'rich'} onClick={showRich}>富文本</button>
      <button type="button" aria-pressed={mode === 'markdown'} onClick={showMarkdown}>Markdown</button>
    </div>
    {mode === 'rich'
      ? <ProseMirrorEditor initialDocument={document} readOnly={readOnly} onDocument={(operations, next) => {
          setDocument(next); onDocument(operations, next);
        }} />
      : <MarkdownEditor source={source} readOnly={readOnly} error={error} onChange={changeSource} />}
  </section>;
}
