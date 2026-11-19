import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import type { PlotGenerationDraft, PlotTreeDraftPayload } from '@storyforge/contracts';
import { subscribeTaskEvents, type TaskEventStream } from '../ai/ai-client';
import { getTree } from '../works/writing-client';
import { plotClient, type CommitGenerationInput, type PlotClient } from './plot-client';
import { plotErrorMessage, usePlotStore } from './plot-state';

interface ChapterOption {
  id: string;
  title: string;
}

interface Props {
  workId: string;
  client?: PlotClient;
  onClose: () => void;
  pollIntervalMs?: number;
  /** SSE 订阅器（测试可注入；默认复用 AI 任务事件流） */
  subscribeEvents?: typeof subscribeTaskEvents;
  /** 章节列表加载（测试可注入） */
  loadChapters?: (workId: string) => Promise<ChapterOption[]>;
}

interface EditableNode {
  key: string;
  title: string;
  summary: string;
  content: string;
  parentIndex: number | null;
}

const MAX_POLLS = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadWorkChapters(id: string): Promise<ChapterOption[]> {
  const tree = await getTree(id);
  return tree.chapters.map((chapter) => ({ id: chapter.id, title: chapter.title }));
}

function toEditable(draft: PlotGenerationDraft): EditableNode[] {
  return (draft.payload?.nodes ?? []).map((node, index) => ({
    key: `${draft.id}-${index}`,
    title: node.title,
    summary: node.summary ?? '',
    content: node.content,
    parentIndex: node.parent_index ?? null
  }));
}

function toPayload(nodes: EditableNode[]): PlotTreeDraftPayload {
  return {
    nodes: nodes.map((node) => ({
      title: node.title.trim(),
      summary: node.summary.trim() ? node.summary.trim() : null,
      content: node.content,
      parent_index: node.parentIndex
    }))
  };
}

/** 自动建树预览：发起解析 → 进度 → 预览编辑 → 覆盖/追加提交或丢弃（02-技术方案 §6.2） */
export function PlotGenerationPreview({
  workId,
  client = plotClient,
  onClose,
  pollIntervalMs = 1500,
  subscribeEvents = subscribeTaskEvents,
  loadChapters = loadWorkChapters
}: Props): JSX.Element {
  const store = usePlotStore();
  const [source, setSource] = useState<'outline' | 'novel_text'>('outline');
  const [text, setText] = useState('');
  const [chapterId, setChapterId] = useState('');
  const [chapters, setChapters] = useState<ChapterOption[]>([]);
  const [draft, setDraft] = useState<PlotGenerationDraft | null>(null);
  const [nodes, setNodes] = useState<EditableNode[]>([]);
  const [mode, setMode] = useState<'replace' | 'append'>('replace');
  const [parentNodeId, setParentNodeId] = useState('');
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const stoppedRef = useRef(false);
  const pollingRef = useRef(false);
  const streamRef = useRef<TaskEventStream | null>(null);

  useEffect(() => {
    stoppedRef.current = false;
    return () => {
      stoppedRef.current = true;
      streamRef.current?.close();
      streamRef.current = null;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void loadChapters(workId)
      .then((list) => { if (active) setChapters(list); })
      .catch(() => { if (active) setChapters([]); });
    return () => { active = false; };
  }, [loadChapters, workId]);

  function closeStream(): void {
    streamRef.current?.close();
    streamRef.current = null;
  }

  function applyDraft(next: PlotGenerationDraft): void {
    setDraft(next);
    setNodes(toEditable(next));
    if (next.status === 'pending') setStatus('解析中…');
    if (next.status === 'succeeded') setStatus('解析完成，请确认预览后提交');
    if (next.status === 'failed') setStatus('解析失败');
  }

  async function poll(draftId: string): Promise<void> {
    if (pollingRef.current) return;
    pollingRef.current = true;
    try {
      for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
        await sleep(pollIntervalMs);
        if (stoppedRef.current) return;
        const { draft: next } = await client.getGeneration(workId, draftId);
        applyDraft(next);
        if (next.status !== 'pending') return;
      }
      setError('解析仍在进行，请稍后重新打开发起解析查看进度');
    } catch (cause) {
      setError(plotErrorMessage(cause));
    } finally {
      pollingRef.current = false;
    }
  }

  async function refresh(draftId: string): Promise<void> {
    const { draft: next } = await client.getGeneration(workId, draftId);
    applyDraft(next);
    if (next.status === 'pending') void poll(draftId);
  }

  /** 优先订阅任务 SSE，通道不可用时回退轮询 */
  function watch(target: PlotGenerationDraft): void {
    const taskId = target.task_id;
    if (typeof taskId !== 'string' || taskId === '') {
      void poll(target.id);
      return;
    }
    closeStream();
    streamRef.current = subscribeEvents(workId, taskId, {
      onEvent: (event) => {
        if (event.type !== 'succeeded' && event.type !== 'failed') return;
        closeStream();
        void refresh(target.id).catch((cause) => setError(plotErrorMessage(cause)));
      },
      onError: () => {
        closeStream();
        void poll(target.id);
      }
    });
  }

  async function start(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    if (busy) return;
    if (source === 'outline' && text.trim().length < 10) {
      setError('大纲内容至少 10 个字符');
      return;
    }
    if (source === 'novel_text' && !chapterId) {
      setError('请选择用于解析的章节');
      return;
    }
    setBusy(true);
    setError('');
    setStatus('提交解析…');
    try {
      const { draft: created } = await client.createGeneration(
        workId,
        source === 'outline'
          ? { source: 'outline', text: text.trim() }
          : { source: 'novel_text', chapter_id: chapterId }
      );
      applyDraft(created);
      if (created.status === 'pending') watch(created);
    } catch (cause) {
      setError(plotErrorMessage(cause));
      setStatus('');
    } finally {
      setBusy(false);
    }
  }

  async function persistEdits(): Promise<void> {
    if (!draft) return;
    if (nodes.some((node) => !node.title.trim())) {
      throw new Error('节点标题不能为空');
    }
    const { draft: saved } = await client.updateGeneration(workId, draft.id, toPayload(nodes));
    applyDraft(saved);
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await persistEdits();
      setStatus('预览已保存');
    } catch (cause) {
      setError(plotErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function commitInput(): CommitGenerationInput {
    if (mode === 'append') {
      return { mode: 'append', parent_node_id: parentNodeId || null, confirm_overwrite: false };
    }
    return { mode: 'replace', confirm_overwrite: true };
  }

  async function commit(): Promise<void> {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      await persistEdits();
      await client.commitGeneration(workId, draft.id, commitInput());
      await store.reload();
      store.setNotice('自动建树已写入剧情树');
      onClose();
    } catch (cause) {
      setError(plotErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function discard(): Promise<void> {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      await client.discardGeneration(workId, draft.id);
      store.setNotice('草稿已丢弃，剧情树未改动');
      onClose();
    } catch (cause) {
      setError(plotErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function updateNode(index: number, patch: Partial<EditableNode>): void {
    setNodes((prev) => prev.map((node, itemIndex) => (itemIndex === index ? { ...node, ...patch } : node)));
  }

  if (draft?.status === 'failed') {
    return (
      <section className="plot-generation" aria-label="自动建树">
        <h3>解析失败</h3>
        <p className="plot-hint">输入内容已保留，可重试解析，或转为手动建树。</p>
        <div className="plot-form-actions">
          <button type="button" disabled={busy} onClick={() => void start()}>重新解析</button>
          <button type="button" onClick={() => {
            store.setNotice('已切换为手动建树，可点击「新增节点」继续');
            onClose();
          }}>转手动建树</button>
          <button type="button" onClick={onClose}>关闭</button>
        </div>
        {error ? <p className="plot-error" role="alert">{error}</p> : null}
      </section>
    );
  }

  if (draft?.status === 'succeeded' && nodes.length > 0) {
    return (
      <section className="plot-generation" aria-label="自动建树">
        <h3>解析预览</h3>
        <p className="plot-hint">共 {nodes.length} 个节点，可调整标题、概要与层级后提交。</p>
        <ol className="plot-generation-nodes">
          {nodes.map((node, index) => (
            <li key={node.key}>
              <label>
                节点 {index + 1} 标题
                <input value={node.title} maxLength={120}
                  onChange={(event) => updateNode(index, { title: event.target.value })} />
              </label>
              <label>
                节点 {index + 1} 概要
                <input value={node.summary} maxLength={255}
                  onChange={(event) => updateNode(index, { summary: event.target.value })} />
              </label>
              <label>
                节点 {index + 1} 层级
                <select value={node.parentIndex ?? ''}
                  onChange={(event) => updateNode(index, {
                    parentIndex: event.target.value === '' ? null : Number(event.target.value)
                  })}>
                  <option value="">根级</option>
                  {nodes.slice(0, index).map((option, optionIndex) => (
                    <option key={option.key} value={optionIndex}>
                      {option.title.trim() || `节点 ${optionIndex + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            </li>
          ))}
        </ol>

        <fieldset>
          <legend>提交方式</legend>
          <label className="plot-check">
            <input type="radio" name="generation-mode" checked={mode === 'replace'}
              onChange={() => setMode('replace')} />
            覆盖现有剧情树
          </label>
          <label className="plot-check">
            <input type="radio" name="generation-mode" checked={mode === 'append'}
              onChange={() => setMode('append')} />
            追加为子树
          </label>
        </fieldset>

        {mode === 'replace' ? (
          <label className="plot-check">
            <input type="checkbox" checked={confirmOverwrite}
              onChange={(event) => setConfirmOverwrite(event.target.checked)} />
            我确认覆盖现有剧情树
          </label>
        ) : (
          <label>
            挂接父节点
            <select value={parentNodeId} onChange={(event) => setParentNodeId(event.target.value)}>
              <option value="">根层</option>
              {store.data.nodes.map((node) => (
                <option key={node.id} value={node.id}>{node.title}</option>
              ))}
            </select>
          </label>
        )}

        <div className="plot-form-actions">
          <button type="button" disabled={busy} onClick={() => void save()}>保存修改</button>
          <button type="button" disabled={busy || (mode === 'replace' && !confirmOverwrite)}
            onClick={() => void commit()}>提交到剧情树</button>
          <button type="button" disabled={busy} onClick={() => void discard()}>丢弃草稿</button>
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
        </div>
        {status ? <p className="plot-notice" role="status">{status}</p> : null}
        {error ? <p className="plot-error" role="alert">{error}</p> : null}
      </section>
    );
  }

  return (
    <section className="plot-generation" aria-label="自动建树">
      <h3>自动建树</h3>
      <form className="plot-form" onSubmit={(event) => void start(event)}>
        <fieldset>
          <legend>输入来源</legend>
          <label className="plot-check">
            <input type="radio" name="generation-source" checked={source === 'outline'}
              onChange={() => setSource('outline')} />
            大纲文本
          </label>
          <label className="plot-check">
            <input type="radio" name="generation-source" checked={source === 'novel_text'}
              onChange={() => setSource('novel_text')} />
            章节正文
          </label>
        </fieldset>

        {source === 'outline' ? (
          <label>
            大纲内容
            <textarea value={text} rows={6} maxLength={20_000}
              placeholder="粘贴大纲，至少 10 个字符"
              onChange={(event) => setText(event.target.value)} />
          </label>
        ) : (
          <label>
            章节
            <select value={chapterId} onChange={(event) => setChapterId(event.target.value)}>
              <option value="">请选择章节</option>
              {chapters.map((chapter) => (
                <option key={chapter.id} value={chapter.id}>{chapter.title}</option>
              ))}
            </select>
          </label>
        )}

        <div className="plot-form-actions">
          <button type="submit" disabled={busy}>开始解析</button>
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
        </div>
        {status ? <p className="plot-notice" role="status">{status}</p> : null}
        {error ? <p className="plot-error" role="alert">{error}</p> : null}
      </form>
    </section>
  );
}
