import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { KnowledgeType, KnowledgeEntry, SearchKnowledgeResponse, ImportPreviewItem } from '@storyforge/contracts';
import {
  createEntryPreview, commitEntry, searchEntries, getEntry, updateEntry, deleteEntry,
  linkEntry, extractOutline, exportMarkdown, importPreview, importMarkdown, validateMarkdown
} from './knowledge-client';
import './knowledge-panel.css';

const TYPE_LABEL: Record<KnowledgeType, string> = {
  article: '文章',
  paper: '论文',
  novel: '小说',
  inspiration: '灵感'
};
const TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: '自动识别' },
  { value: 'article', label: '文章' },
  { value: 'paper', label: '论文' },
  { value: 'novel', label: '小说' },
  { value: 'inspiration', label: '灵感' }
];
const SOURCE_LABEL: Record<string, string> = {
  paste: '粘贴', manual: '手动', upload: '上传', ocr: 'OCR', import: '导入'
};

// ───────────────────────── 录入预览表单态 ─────────────────────────
interface PreviewState {
  type: KnowledgeType;
  title: string;
  raw_content: string;
  structured: Record<string, unknown>;
  tags: string[];
  degraded?: boolean;
}
const EMPTY_PREVIEW: PreviewState = {
  type: 'article', title: '', raw_content: '', structured: {}, tags: []
};

// ───────────────────────── 子组件：结构化编辑 ─────────────────────────
function StructuredEditor({ preview, onChange }: {
  preview: PreviewState;
  onChange: (next: PreviewState) => void;
}): JSX.Element {
  const s = preview.structured;
  function setStructured(key: string, value: unknown): void {
    onChange({ ...preview, structured: { ...s, [key]: value } });
  }
  return <div className="kb-structured">
    {preview.type === 'article' && (
      <>
        <label htmlFor="kb-summary">摘要</label>
        <textarea id="kb-summary" rows={2} value={String(s.summary ?? '')}
          onChange={(e) => setStructured('summary', e.target.value)} />
        <label htmlFor="kb-paras">段落（每行一段）</label>
        <textarea id="kb-paras" rows={5}
          value={(Array.isArray(s.paragraphs) ? s.paragraphs as string[] : []).join('\n')}
          onChange={(e) => setStructured('paragraphs', e.target.value.split('\n').filter(Boolean))} />
        <label htmlFor="kb-points">要点（每行一个）</label>
        <textarea id="kb-points" rows={3}
          value={(Array.isArray(s.key_points) ? s.key_points as string[] : []).join('\n')}
          onChange={(e) => setStructured('key_points', e.target.value.split('\n').filter(Boolean))} />
        <label htmlFor="kb-taglist">标签（逗号分隔）</label>
        <input id="kb-taglist" type="text"
          value={(Array.isArray(s.tag_list) ? s.tag_list as string[] : []).join('，')}
          onChange={(e) => setStructured('tag_list', e.target.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean))} />
      </>
    )}
    {preview.type === 'paper' && (
      <>
        <label htmlFor="kb-rq">研究问题</label>
        <textarea id="kb-rq" rows={2} value={String(s.research_question ?? '')} onChange={(e) => setStructured('research_question', e.target.value)} />
        <label htmlFor="kb-rm">研究方法</label>
        <textarea id="kb-rm" rows={2} value={String(s.research_method ?? '')} onChange={(e) => setStructured('research_method', e.target.value)} />
        <label htmlFor="kb-cc">核心结论</label>
        <textarea id="kb-cc" rows={2} value={String(s.core_conclusion ?? '')} onChange={(e) => setStructured('core_conclusion', e.target.value)} />
        <label htmlFor="kb-li">局限</label>
        <textarea id="kb-li" rows={2} value={String(s.limitation ?? '')} onChange={(e) => setStructured('limitation', e.target.value)} />
        <label htmlFor="kb-di">设计启发</label>
        <textarea id="kb-di" rows={2} value={String(s.design_insight ?? '')} onChange={(e) => setStructured('design_insight', e.target.value)} />
      </>
    )}
    {preview.type === 'novel' && (
      <>
        <label htmlFor="kb-chars">人物（每行一个）</label>
        <textarea id="kb-chars" rows={3}
          value={(Array.isArray(s.characters) ? s.characters as string[] : []).join('\n')}
          onChange={(e) => setStructured('characters', e.target.value.split('\n').filter(Boolean))} />
        <label htmlFor="kb-plots">情节线（每行一条）</label>
        <textarea id="kb-plots" rows={4}
          value={(Array.isArray(s.plot_lines) ? s.plot_lines as string[] : []).join('\n')}
          onChange={(e) => setStructured('plot_lines', e.target.value.split('\n').filter(Boolean))} />
        <label htmlFor="kb-narrative">叙事风格（每行一个）</label>
        <textarea id="kb-narrative" rows={2}
          value={(Array.isArray(s.narrative_style) ? s.narrative_style as string[] : []).join('\n')}
          onChange={(e) => setStructured('narrative_style', e.target.value.split('\n').filter(Boolean))} />
        <label htmlFor="kb-world">世界观设定</label>
        <textarea id="kb-world" rows={2} value={String(s.world_setting ?? '')} onChange={(e) => setStructured('world_setting', e.target.value)} />
      </>
    )}
    {preview.type === 'inspiration' && (
      <>
        <label htmlFor="kb-rawtext">原始灵感</label>
        <textarea id="kb-rawtext" rows={3} value={String(s.raw_text ?? preview.raw_content)} onChange={(e) => setStructured('raw_text', e.target.value)} />
        <label htmlFor="kb-enriched">补充完善</label>
        <textarea id="kb-enriched" rows={4} value={String(s.enriched_text ?? '')} onChange={(e) => setStructured('enriched_text', e.target.value)} />
      </>
    )}
  </div>;
}

// ───────────────────────── 子面板：录入 ─────────────────────────
function EntryTab(): JSX.Element {
  const [source, setSource] = useState<'paste' | 'manual'>('paste');
  const [typeInput, setTypeInput] = useState('auto');
  const [title, setTitle] = useState('');
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [tags, setTags] = useState('');

  async function submitEntry(): Promise<void> {
    if (busy || !raw.trim()) { setError('请输入内容'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await createEntryPreview({
        source, type: typeInput as 'auto' | KnowledgeType,
        title: title || undefined, raw_content: raw
      });
      if (result.status === 'type_uncertain') {
        setNotice('无法自动确定知识类型，请在「类型」下拉中手动指定后重试。');
        return;
      }
      if (result.status === 'saved') {
        setNotice(`内容已存在（条目 ${result.id}），未重复入库。`);
        return;
      }
      if (result.type && result.structured) {
        setPreviewId(result.id ?? null);
        const next: PreviewState = {
          type: result.type as KnowledgeType,
          title: result.title ?? title,
          raw_content: raw,
          structured: result.structured,
          tags: result.tags ?? []
        };
        if (result.degraded !== undefined) next.degraded = result.degraded;
        setPreview(next);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '录入失败');
    } finally {
      setBusy(false);
    }
  }

  async function commitPreview(): Promise<void> {
    if (!preview || busy) return;
    setBusy(true); setError('');
    try {
      const finalTags = tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
      await commitEntry(previewId ?? crypto.randomUUID(), {
        type: preview.type, title: preview.title, source,
        raw_content: preview.raw_content, structured: preview.structured, tags: finalTags, links: []
      });
      setNotice('入库成功。');
      setPreview(null); setPreviewId(null); setRaw(''); setTitle(''); setTags('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '入库失败');
    } finally {
      setBusy(false);
    }
  }

  return <section className="kb-tab" aria-label="知识录入">
    <div className="kb-field-row">
      <label htmlFor="kb-source">来源</label>
      <select id="kb-source" value={source} onChange={(e) => setSource(e.target.value as 'paste' | 'manual')}>
        <option value="paste">粘贴文本</option>
        <option value="manual">手动录入</option>
      </select>
      <label htmlFor="kb-type">类型</label>
      <select id="kb-type" value={typeInput} onChange={(e) => setTypeInput(e.target.value)}>
        {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
    <label htmlFor="kb-title">标题（可选，留空由 LLM 识别）</label>
    <input id="kb-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
    <label htmlFor="kb-raw">内容</label>
    <textarea id="kb-raw" rows={8} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="粘贴或输入要录入的知识内容…" />
    <div className="kb-actions">
      <button type="button" disabled={busy} onClick={() => void submitEntry()}>{busy ? '处理中' : '生成预览'}</button>
      {preview && (
        <button type="button" disabled={busy} onClick={() => void commitPreview()}>{busy ? '入库中' : '确认入库'}</button>
      )}
    </div>
    {error && <p className="kb-error" role="alert">{error}</p>}
    {notice && <p className="kb-notice" role="status">{notice}</p>}

    {preview && (
      <div className="kb-preview">
        <h4>预览 · {TYPE_LABEL[preview.type]}</h4>
        {preview.degraded && <p className="kb-warning">拆分失败，已降级为原文存储。</p>}
        <label htmlFor="kb-pv-title">标题</label>
        <input id="kb-pv-title" type="text" value={preview.title}
          onChange={(e) => setPreview({ ...preview, title: e.target.value })} />
        <StructuredEditor preview={preview} onChange={setPreview} />
        <label htmlFor="kb-pv-tags">标签（逗号分隔）</label>
        <input id="kb-pv-tags" type="text" value={tags} onChange={(e) => setTags(e.target.value)} />
      </div>
    )}
  </section>;
}

// ───────────────────────── 子面板：检索 ─────────────────────────
function SearchTab(): JSX.Element {
  const [keyword, setKeyword] = useState('');
  const [type, setType] = useState('');
  const [tag, setTag] = useState('');
  const [result, setResult] = useState<SearchKnowledgeResponse | null>(null);
  const [detail, setDetail] = useState<KnowledgeEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const runSearch = useCallback(async (page = 1): Promise<void> => {
    setBusy(true); setError('');
    try {
      const res = await searchEntries({
        keyword: keyword || undefined,
        type: (type || undefined) as KnowledgeType | undefined,
        tag: tag || undefined,
        page, page_size: 20
      });
      setResult(res);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '检索失败');
    } finally {
      setBusy(false);
    }
  }, [keyword, type, tag]);

  useEffect(() => { void runSearch(1); }, [runSearch]);

  async function openDetail(id: string): Promise<void> {
    setBusy(true); setError('');
    try {
      setDetail(await getEntry(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载详情失败');
    } finally {
      setBusy(false);
    }
  }

  async function removeEntry(id: string): Promise<void> {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await deleteEntry(id);
      setNotice('已删除。');
      setDetail(null);
      await runSearch(1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  async function extractOutlineFor(id: string): Promise<void> {
    setBusy(true); setError(''); setNotice('');
    try {
      const res = await extractOutline({ novel_id: id });
      if (res.error === 'no_chapters') {
        setNotice('未识别到章节标题，无法自动提取大纲，请手动补充。');
      } else {
        setNotice('大纲提取完成。');
        await openDetail(id);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '大纲提取失败');
    } finally {
      setBusy(false);
    }
  }

  return <section className="kb-tab" aria-label="知识检索">
    <div className="kb-filter">
      <label htmlFor="kb-kw">关键词</label>
      <input id="kb-kw" type="text" value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="标题/正文/结构化" />
      <label htmlFor="kb-ftype">类型</label>
      <select id="kb-ftype" value={type} onChange={(e) => setType(e.target.value)}>
        <option value="">全部</option>
        {TYPE_OPTIONS.filter((o) => o.value !== 'auto').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <label htmlFor="kb-ftag">标签</label>
      <input id="kb-ftag" type="text" value={tag} onChange={(e) => setTag(e.target.value)} />
    </div>

    {error && <p className="kb-error" role="alert">{error}</p>}
    {notice && <p className="kb-notice" role="status">{notice}</p>}

    {detail ? (
      <div className="kb-detail">
        <h4>{detail.title} <span className="kb-type-tag">{TYPE_LABEL[detail.type]}</span></h4>
        <p className="kb-meta">来源：{SOURCE_LABEL[detail.source] ?? detail.source} · 标签：{detail.tags.join('、') || '无'}</p>
        <div className="kb-detail-actions">
          {detail.type === 'novel' && (
            <button type="button" disabled={busy} onClick={() => void extractOutlineFor(detail.id)}>提取大纲</button>
          )}
          <button type="button" disabled={busy} onClick={() => void removeEntry(detail.id)}>删除</button>
          <button type="button" disabled={busy} onClick={() => setDetail(null)}>返回列表</button>
        </div>
        <details className="kb-structured-view" open>
          <summary>结构化结果</summary>
          <pre>{JSON.stringify(detail.structured, null, 2)}</pre>
        </details>
        <details>
          <summary>原文</summary>
          <pre className="kb-raw">{detail.raw_content}</pre>
        </details>
      </div>
    ) : (
      <div className="kb-list">
        {result?.total === 0 && <p className="kb-empty">暂无匹配条目，试试放宽筛选条件。</p>}
        {result?.items.map((item) => (
          <article key={item.id} className="kb-card" aria-label={item.title}>
            <button type="button" className="kb-card-main" disabled={busy} onClick={() => void openDetail(item.id)}>
              <span className="kb-card-title">{item.title}</span>
              <span className={`kb-type-tag kb-type-${item.type}`}>{TYPE_LABEL[item.type]}</span>
            </button>
            <p className="kb-meta">{item.tags.join('、') || '无标签'} · {new Date(item.created_at).toLocaleString()}</p>
          </article>
        ))}
        {result && result.total > (result.items.length) && (
          <div className="kb-pager">
            <button type="button" disabled={busy} onClick={() => void runSearch(1)}>第 1 页</button>
            <span>共 {result.total} 条</span>
          </div>
        )}
      </div>
    )}
  </section>;
}

// ───────────────────────── 子面板：Markdown 导入导出 ─────────────────────────
function MarkdownTab(): JSX.Element {
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [targetType, setTargetType] = useState<KnowledgeType>('article');
  const [conflictStrategy, setConflictStrategy] = useState<'overwrite' | 'rename' | 'skip'>('rename');
  const [previewItems, setPreviewItems] = useState<ImportPreviewItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFile(f: File): Promise<void> {
    setError(''); setNotice(''); setPreviewItems(null);
    if (!f.name.toLowerCase().endsWith('.md') && !f.name.toLowerCase().endsWith('.markdown')) {
      setError('仅支持 .md / .markdown 文件。');
      return;
    }
    const content = await f.text();
    setFile({ name: f.name, content });
  }

  async function runPreview(): Promise<void> {
    if (!file || busy) return;
    setBusy(true); setError('');
    try {
      const res = await importPreview({ files: [{ file_name: file.name, content: file.content }], target_type: targetType });
      setPreviewItems(res.items);
      setNotice(`预览完成，共 ${res.items.length} 个文件。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '预览失败');
    } finally {
      setBusy(false);
    }
  }

  async function runImport(): Promise<void> {
    if (!file || !previewItems || busy) return;
    setBusy(true); setError('');
    try {
      const res = await importMarkdown({
        items: previewItems.map((i) => ({ file_name: i.file_name, title: i.title, type: i.type, content: i.content })),
        target_type: targetType,
        conflict_strategy: conflictStrategy
      });
      setNotice(`导入完成：成功 ${res.success}，失败 ${res.failed}，新建 ${res.created}，更新 ${res.updated}。`);
      setPreviewItems(null);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导入失败');
    } finally {
      setBusy(false);
    }
  }

  async function runExport(): Promise<void> {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const res = await exportMarkdown({ mode, entry_ids: mode === 'single' ? undefined : undefined });
      if (mode === 'single' && res.content && res.file_name) {
        download(res.content, res.file_name, 'text/markdown');
      } else if (res.zip_base64) {
        const bytes = atob(res.zip_base64);
        const arr = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
        download(URL.createObjectURL(new Blob([arr], { type: 'application/zip' })), `knowledge-export-${Date.now()}.zip`, 'application/zip');
      }
      setNotice(`导出完成：${res.total} 条。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导出失败');
    } finally {
      setBusy(false);
    }
  }

  return <section className="kb-tab" aria-label="Markdown 导入导出">
    <h4>导入</h4>
    <label htmlFor="kb-md-type">目标类型</label>
    <select id="kb-md-type" value={targetType} onChange={(e) => setTargetType(e.target.value as KnowledgeType)}>
      {TYPE_OPTIONS.filter((o) => o.value !== 'auto').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
    <label htmlFor="kb-md-file" className="kb-file-label">选择 Markdown 文件（.md / .markdown）</label>
    <input id="kb-md-file" ref={fileRef} type="file" accept=".md,.markdown" onChange={(e) => {
      const f = e.target.files?.[0]; if (f) void handleFile(f);
    }} />
    {file && <p className="kb-notice">已选择：{file.name}（{file.content.length} 字符）</p>}
    <div className="kb-actions">
      <button type="button" disabled={busy || !file} onClick={() => void runPreview()}>预览</button>
      {previewItems && (
        <button type="button" disabled={busy} onClick={() => void runImport()}>确认导入</button>
      )}
    </div>
    {previewItems && (
      <div className="kb-preview">
        <h5>冲突策略</h5>
        <label htmlFor="kb-cs">策略</label>
        <select id="kb-cs" value={conflictStrategy} onChange={(e) => setConflictStrategy(e.target.value as 'overwrite' | 'rename' | 'skip')}>
          <option value="overwrite">覆盖</option>
          <option value="rename">重命名</option>
          <option value="skip">跳过</option>
        </select>
        {previewItems.map((item) => (
          <p key={item.file_name} className="kb-md-item">
            {item.file_name} → {item.title}（{item.conflict}）
          </p>
        ))}
      </div>
    )}

    <h4>导出</h4>
    <label htmlFor="kb-md-mode">模式</label>
    <select id="kb-md-mode" value={mode} onChange={(e) => setMode(e.target.value as 'single' | 'batch')}>
      <option value="single">单文件（最新 1 条）</option>
      <option value="batch">批量 ZIP</option>
    </select>
    <div className="kb-actions">
      <button type="button" disabled={busy} onClick={() => void runExport()}>导出</button>
    </div>

    {error && <p className="kb-error" role="alert">{error}</p>}
    {notice && <p className="kb-notice" role="status">{notice}</p>}
  </section>;
}

function download(data: string, name: string, type: string): void {
  const a = window.document.createElement('a');
  a.href = data;
  a.download = name;
  a.click();
}

// ───────────────────────── 入口 ─────────────────────────
export function KnowledgePanel(): JSX.Element {
  const [tab, setTab] = useState<'entry' | 'search' | 'markdown'>('entry');
  return <div className="kb-panel">
    <h2>知识库</h2>
    <div className="kb-tabs" role="tablist" aria-label="知识库功能页签">
      {([['entry', '录入'], ['search', '检索'], ['markdown', '导入导出']] as const).map(([key, label]) => (
        <button key={key} type="button" role="tab" aria-selected={tab === key}
          className={`kb-tab-btn ${tab === key ? 'kb-tab-active' : ''}`}
          onClick={() => setTab(key)}>{label}</button>
      ))}
    </div>
    {tab === 'entry' && <EntryTab />}
    {tab === 'search' && <SearchTab />}
    {tab === 'markdown' && <MarkdownTab />}
  </div>;
}
