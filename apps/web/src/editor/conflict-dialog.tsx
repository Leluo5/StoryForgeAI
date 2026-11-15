import type { ProseMirrorNode } from '@storyforge/contracts';
import { documentToMarkdown, markdownToDocument, parseDocument } from '@storyforge/editor-schema';
import { useEffect, useRef, useState } from 'react';
import type { WriterConflict } from './use-chapter-writer';

interface Props {
  conflict?: WriterConflict | undefined;
  onResolve(document: ProseMirrorNode): Promise<void>;
  onRestore(): Promise<void>;
  onExport(): Promise<string>;
}
export function ConflictDialog({ conflict, onResolve, onRestore, onExport }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [manual, setManual] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (conflict && !ref.current?.open) {
      setManual(documentToMarkdown(conflict.localDocument)); ref.current?.showModal();
    }
    if (!conflict && ref.current?.open) ref.current.close();
  }, [conflict]);
  if (!conflict) return null;

  async function choose(document: ProseMirrorNode) {
    setPending(true); setError('');
    try { await onResolve(document); } catch (cause) { setError(cause instanceof Error ? cause.message : '冲突处理失败'); }
    finally { setPending(false); }
  }
  async function merge() {
    try { await choose(markdownToDocument(manual)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Markdown 解析失败'); setPending(false); }
  }
  async function download() {
    const blob = new Blob([await onExport()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `chapter-${conflict?.baseVersion}-recovery.json`; anchor.click();
    URL.revokeObjectURL(url);
  }
  return <dialog ref={ref} aria-labelledby="conflict-title">
    <h2 id="conflict-title">版本冲突</h2>
    <p>请求 ID：{conflict.requestId}。共同基准版本 {conflict.baseVersion}，服务端版本 {conflict.serverVersion}。</p>
    <h3>共同基准</h3><pre>{parseDocument(conflict.baseDocument).textContent}</pre>
    <h3>本地未确认</h3><pre>{parseDocument(conflict.localDocument).textContent}</pre>
    <h3>服务端当前</h3><pre>{parseDocument(conflict.serverDocument).textContent}</pre>
    <button disabled={pending} onClick={() => void choose(conflict.localDocument)}>使用本地</button>
    <button disabled={pending} onClick={() => void choose(conflict.serverDocument)}>使用服务端</button>
    <label htmlFor="manual-merge">手动合并</label>
    <textarea id="manual-merge" value={manual} onChange={(event) => setManual(event.target.value)} />
    <button disabled={pending} onClick={() => void merge()}>确认合并</button>
    <button disabled={pending} onClick={() => void download()}>导出恢复数据</button>
    <button disabled={pending} onClick={() => {
      if (window.confirm('从服务端恢复会保留本地备份并清除未确认日志，确认继续？')) void onRestore();
    }}>从服务端恢复</button>
    {error && <p role="alert">{error}</p>}
  </dialog>;
}
