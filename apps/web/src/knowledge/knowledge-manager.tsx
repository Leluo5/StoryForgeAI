import { useCallback, useEffect, useMemo, useReducer, useState, type JSX } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Badge, Spinner, Modal } from '@storyforge/ui';
import type {
  KnowledgeConflictPolicy,
  KnowledgeEntryDetail,
  KnowledgeEntryOutline,
  KnowledgeEntrySummary,
  KnowledgeEntryStructured,
  KnowledgeEntryType,
  KnowledgeImportPreviewResponse,
  KnowledgeRestorePreviewResponse,
  KnowledgeScope,
  KnowledgeTag
} from '@storyforge/contracts';
import { knowledgeClient } from './knowledge-client';
import { knowledgeInitialState, knowledgeReducer, knowledgeErrorMessage, type KnowledgeState } from './knowledge-state';
import { EntryCreate } from './entry-create';
import { ImportExport, type ExportRange } from './import-export';
import { BackupPanel } from './backup-panel';
import './knowledge-manager.css';

// ───────────────────────── 常量 ─────────────────────────

const TYPE_META: Record<KnowledgeEntryType, { label: string }> = {
  article: { label: '文章' },
  paper: { label: '论文' },
  novel: { label: '小说' },
  inspiration: { label: '灵感' },
  setting: { label: '设定集' }
};

const ALL_TYPES: KnowledgeEntryType[] = ['article', 'paper', 'novel', 'inspiration', 'setting'];

function isEntryType(value: string | undefined): value is KnowledgeEntryType {
  return Boolean(value) && (ALL_TYPES as string[]).includes(value as string);
}

type SortField = 'updated_at' | 'created_at' | 'title';

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ───────────────────────── 子组件：类型图标 ─────────────────────────

function TypeIcon({ type }: { type: KnowledgeEntryType }): JSX.Element {
  const glyph: Record<KnowledgeEntryType, string> = {
    article: '📄', paper: '📊', novel: '📖', inspiration: '💡', setting: '🌍'
  };
  return <span aria-hidden="true" className="kb-mgr__type-glyph">{glyph[type]}</span>;
}

// ───────────────────────── 子组件：标签 chips ─────────────────────────

function TagChips({ tags, max = 3 }: { tags: string[]; max?: number }): JSX.Element {
  if (tags.length === 0) return <span className="kb-mgr__nav-empty">无标签</span>;
  const shown = tags.slice(0, max);
  const extra = tags.length - shown.length;
  return (
    <span className="kb-mgr__tags">
      {shown.map((tag) => <span key={tag} className="kb-mgr__tag">{tag}</span>)}
      {extra > 0 && <span className="kb-mgr__tag">+{extra}</span>}
    </span>
  );
}

// ───────────────────────── 子组件：详情区块（可折叠） ─────────────────────────

function DetailBlock({ title, children, defaultOpen = true }: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="kb-mgr__detail-block">
      <div className="kb-mgr__detail-block-head">
        <h4 className="kb-mgr__detail-block-title">{title}</h4>
        <button type="button" className="kb-mgr__detail-block-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '展开'}
        </button>
      </div>
      {open && <div>{children}</div>}
    </section>
  );
}

// ───────────────────────── 子组件：类型专属模板 ─────────────────────────

function StructuredTemplate({ structured }: { structured: KnowledgeEntryStructured }): JSX.Element {
  switch (structured.entry_type) {
    case 'article':
    case 'setting': {
      const { sections, key_points } = structured;
      return (
        <>
          {sections.length > 0 && (
            <DetailBlock title="分段">
              {sections.map((sec, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <p className="kb-mgr__field"><strong>{sec.heading}</strong></p>
                  <p className="kb-mgr__field kb-mgr__field--secondary">{sec.content}</p>
                </div>
              ))}
            </DetailBlock>
          )}
          {key_points.length > 0 && (
            <DetailBlock title="核心观点">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {key_points.map((p, i) => <li key={i} className="kb-mgr__field">{p}</li>)}
              </ul>
            </DetailBlock>
          )}
        </>
      );
    }
    case 'paper': {
      const fields: Array<[string, string]> = [
        ['研究问题', structured.research_question],
        ['方法', structured.method],
        ['发现', structured.findings],
        ['贡献', structured.contributions],
        ['局限', structured.limitations]
      ];
      return (
        <>
          {fields.map(([label, value]) => value ? (
            <DetailBlock key={label} title={label}>
              <p className="kb-mgr__field">{value}</p>
            </DetailBlock>
          ) : null)}
        </>
      );
    }
    case 'novel': {
      const { characters, plot_summary, narrative_style, worldview } = structured;
      return (
        <>
          {characters.length > 0 && (
            <DetailBlock title={`角色（${characters.length}）`}>
              {characters.map((c, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <p className="kb-mgr__field"><strong>{c.name}</strong>{c.role ? ` · ${c.role}` : ''}</p>
                  {c.description && <p className="kb-mgr__field kb-mgr__field--secondary">{c.description}</p>}
                </div>
              ))}
            </DetailBlock>
          )}
          {plot_summary && (
            <DetailBlock title="情节摘要"><p className="kb-mgr__field">{plot_summary}</p></DetailBlock>
          )}
          {narrative_style && (
            <DetailBlock title="叙事风格"><p className="kb-mgr__field">{narrative_style}</p></DetailBlock>
          )}
          {worldview && (
            <DetailBlock title="世界观"><p className="kb-mgr__field">{worldview}</p></DetailBlock>
          )}
        </>
      );
    }
    case 'inspiration': {
      const { completion, matched_entry_ids, independent } = structured;
      return (
        <>
          {completion && (
            <DetailBlock title="补充完善"><p className="kb-mgr__field">{completion}</p></DetailBlock>
          )}
          <p className="kb-mgr__field kb-mgr__field--secondary">
            独立灵感：{independent ? '是' : '否'}
            {matched_entry_ids.length > 0 ? ` · 关联条目 ${matched_entry_ids.length} 条` : ''}
          </p>
        </>
      );
    }
    default:
      return <p className="kb-mgr__field kb-mgr__field--secondary">暂无结构化模板。</p>;
  }
}

// ───────────────────────── 子组件：四维大纲 ─────────────────────────

function OutlineTree({ outline }: { outline: KnowledgeEntryOutline }): JSX.Element | null {
  const hasAny = outline.chapters.length > 0 || outline.plot_nodes.length > 0 ||
    outline.character_relations.length > 0 || outline.story_lines.length > 0;
  if (!hasAny) return null;

  return (
    <DetailBlock title="四维大纲">
      {outline.chapters.length > 0 && (
        <div className="kb-mgr__outline-section">
          <p className="kb-mgr__outline-heading">章节 <span className="kb-mgr__outline-count">{outline.chapters.length}</span></p>
          {outline.chapters.map((c, i) => (
            <p key={i} className="kb-mgr__outline-item">
              {c.title}
              {c.summary && <small>{c.summary}</small>}
            </p>
          ))}
        </div>
      )}
      {outline.plot_nodes.length > 0 && (
        <div className="kb-mgr__outline-section">
          <p className="kb-mgr__outline-heading">情节节点 <span className="kb-mgr__outline-count">{outline.plot_nodes.length}</span></p>
          {outline.plot_nodes.map((n, i) => (
            <p key={i} className="kb-mgr__outline-item">
              第{String(n.chapter_index + 1)}章 · {n.title}
              {n.summary && <small>{n.summary}</small>}
            </p>
          ))}
        </div>
      )}
      {outline.character_relations.length > 0 && (
        <div className="kb-mgr__outline-section">
          <p className="kb-mgr__outline-heading">人物关系 <span className="kb-mgr__outline-count">{outline.character_relations.length}</span></p>
          {outline.character_relations.map((r, i) => (
            <p key={i} className="kb-mgr__outline-item">{r.source} — {r.relation} — {r.target}</p>
          ))}
        </div>
      )}
      {outline.story_lines.length > 0 && (
        <div className="kb-mgr__outline-section">
          <p className="kb-mgr__outline-heading">故事线 <span className="kb-mgr__outline-count">{outline.story_lines.length}</span></p>
          {outline.story_lines.map((l, i) => (
            <p key={i} className="kb-mgr__outline-item">
              {l.name}
              {l.description && <small>{l.description}</small>}
            </p>
          ))}
        </div>
      )}
    </DetailBlock>
  );
}

// ───────────────────────── 子组件：右侧详情面板 ─────────────────────────

function DetailPanel({ detail, loading, onClose, onToggleFavorite }: {
  detail: KnowledgeEntryDetail | null;
  loading: boolean;
  onClose: () => void;
  onToggleFavorite: (detail: KnowledgeEntryDetail) => void;
}): JSX.Element {
  if (loading) {
    return (
      <aside className="kb-mgr__detail" aria-label="知识条目详情">
        <div className="kb-mgr__detail-state" role="status"><Spinner label="正在加载详情…" /></div>
      </aside>
    );
  }
  if (!detail) {
    return (
      <aside className="kb-mgr__detail" aria-label="知识条目详情">
        <div className="kb-mgr__detail-state">从左侧列表选择条目查看详情</div>
      </aside>
    );
  }

  const meta = TYPE_META[detail.entry_type];
  return (
    <aside className="kb-mgr__detail" aria-label="知识条目详情">
      <div className="kb-mgr__detail-head">
        <h3 className="kb-mgr__detail-title">{detail.title}</h3>
        <button type="button" className="kb-mgr__detail-close" aria-label="关闭详情" onClick={onClose}>✕</button>
      </div>
      <div className="kb-mgr__detail-body">
        <div className="kb-mgr__meta-row">
          <Badge variant="accent">{meta.label}</Badge>
          <span>创建 {formatTime(detail.created_at)}</span>
          <span>更新 {formatTime(detail.updated_at)}</span>
          <span>v{detail.version}</span>
          {detail.favorite && <span className="kb-mgr__flag">★ 已收藏</span>}
          {detail.pinned && <span className="kb-mgr__flag">📌 置顶</span>}
        </div>

        <DetailBlock title="标签">
          <TagChips tags={detail.tags} max={20} />
        </DetailBlock>

        <DetailBlock title="原文" defaultOpen={false}>
          <p className="kb-mgr__field kb-mgr__field--secondary" style={{ maxHeight: 240, overflowY: 'auto' }}>
            {detail.original_text || '（空）'}
          </p>
        </DetailBlock>

        <DetailBlock title="结构化内容">
          {detail.structured
            ? <StructuredTemplate structured={detail.structured} />
            : <p className="kb-mgr__field kb-mgr__field--secondary">尚无结构化内容，状态：{detail.structure_status}。</p>}
        </DetailBlock>

        {detail.entry_type === 'novel' && detail.outline && <OutlineTree outline={detail.outline} />}
      </div>
      <div className="kb-mgr__actions">
        <Button variant="secondary" size="sm" onClick={() => onToggleFavorite(detail)}>
          {detail.favorite ? '取消收藏' : '收藏'}
        </Button>
        <Button variant="secondary" size="sm">导出 Markdown</Button>
        <Button variant="primary" size="sm">引用到作品</Button>
      </div>
    </aside>
  );
}

// ───────────────────────── 子组件：列表卡片 ─────────────────────────

function EntryCard({ item, selected, checked, onSelect, onToggleCheck }: {
  item: KnowledgeEntrySummary;
  selected: boolean;
  checked: boolean;
  onSelect: () => void;
  onToggleCheck: () => void;
}): JSX.Element {
  const meta = TYPE_META[item.entry_type];
  return (
    <article
      className={`kb-mgr__card${selected ? ' kb-mgr__card--selected' : ''}${checked ? ' kb-mgr__card--checked' : ''}`}
      onClick={onSelect}
      aria-selected={selected}
    >
      <div className="kb-mgr__card-top">
        <input
          type="checkbox"
          className="kb-mgr__card-check"
          checked={checked}
          onChange={onToggleCheck}
          onClick={(e) => e.stopPropagation()}
          aria-label={`选中 ${item.title}`}
        />
        <TypeIcon type={item.entry_type} />
        <span className="kb-mgr__card-title">{item.title}</span>
        {(item.favorite || item.pinned) && (
          <span className="kb-mgr__card-flags">
            {item.favorite && <span className="kb-mgr__flag">★</span>}
            {item.pinned && <span className="kb-mgr__flag">📌</span>}
          </span>
        )}
      </div>
      <div className="kb-mgr__card-meta">
        <Badge variant="accent">{meta.label}</Badge>
        <span>{formatTime(item.updated_at)}</span>
        {item.structure_status === 'ready' && <span>✓ 已结构化</span>}
        {item.structure_status === 'pending' && <span>⏳ 待结构化</span>}
        {item.structure_status === 'failed' && <span>⚠ 结构化失败</span>}
      </div>
      <TagChips tags={item.tags} max={3} />
      {item.excerpt && <p className="kb-mgr__card-excerpt">{item.excerpt}</p>}
    </article>
  );
}

// ───────────────────────── 主组件 ─────────────────────────

export function KnowledgeManager(): JSX.Element {
  const [searchParams] = useSearchParams();
  // 当前作品 id：来自 URL 查询参数 `?work_id=xxx`（方案 C §3.5「当前作品」库需已选中作品，
  // 从工作台/抽屉「全屏管理」跳转携带）。无 work_id 时禁用「当前作品」库。
  const urlWorkId = searchParams.get('work_id') ?? undefined;
  // 从抽屉（方案 D）「全屏管理 →」跳转携带的筛选：?q= 关键词 / ?type=a,b 类型 / ?entry= 选中条目
  const urlKeyword = searchParams.get('q') ?? '';
  const urlType = searchParams.get('type') ?? '';
  const urlEntry = searchParams.get('entry') ?? '';
  const [state, dispatch] = useReducer(knowledgeReducer, knowledgeInitialState, (init) => {
    if (!urlWorkId) return init;
    const next: KnowledgeState = { ...init, scope: 'work', workId: urlWorkId };
    return next;
  });
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() => (urlEntry ? urlEntry : null));
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [activeType, setActiveType] = useState<KnowledgeEntryType | 'all'>(() => {
    const first = urlType.split(',').filter((value) => value.length > 0)[0];
    return isEntryType(first) ? first : 'all';
  });
  const [tags, setTags] = useState<KnowledgeTag[]>([]);
  const [keyword, setKeyword] = useState(() => urlKeyword);
  const [sortField, setSortField] = useState<SortField>('updated_at');

  // 录入 / 导入导出 / 备份 弹窗（方案 C §3.5）
  const [createOpen, setCreateOpen] = useState(false);
  const [ioOpen, setIoOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [ioLoading, setIoLoading] = useState(false);
  const [ioError, setIoError] = useState<string | undefined>(undefined);
  const [ioPreview, setIoPreview] = useState<KnowledgeImportPreviewResponse | undefined>(undefined);
  const [ioCommitting, setIoCommitting] = useState(false);
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupError, setBackupError] = useState<string | undefined>(undefined);
  const [backupPreview, setBackupPreview] = useState<KnowledgeRestorePreviewResponse | undefined>(undefined);
  const [backupCommitting, setBackupCommitting] = useState(false);

  // 批量删除确认（方案 C §3.4：多选批量操作流程完整，无死状态）
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  // 真实作品上下文：唯一来源是 URL `?work_id=`（方案 C §3.5「当前作品」库需已选中作品）。
  // 按钮可用性取决于 urlWorkId；数据请求的 work_id 仅在 work scope 时由 state.workId 携带。
  const workId = state.scope === 'work' ? state.workId : undefined;
  const effectiveScope: KnowledgeScope = state.scope === 'work' && !workId ? 'global' : state.scope;

  // 加载标签云
  useEffect(() => {
    let cancelled = false;
    knowledgeClient.listTags({ scope: effectiveScope, work_id: workId }).then((list) => {
      if (!cancelled) setTags(list);
    }).catch(() => {
      if (!cancelled) setTags([]);
    });
    return () => { cancelled = true; };
  }, [effectiveScope, workId]);

  // 加载列表（筛选变化即时请求）
  useEffect(() => {
    let cancelled = false;
    dispatch({ type: 'LIST_LOADING' });
    const types = activeType === 'all' ? undefined : [activeType];
    knowledgeClient.listEntries({
      scope: effectiveScope,
      work_id: workId,
      keyword: keyword || undefined,
      types,
      time_field: sortField === 'title' ? 'updated_at' : sortField,
      limit: 50
    }).then((res) => {
      if (cancelled) return;
      const cacheKey = [effectiveScope, workId ?? '', keyword, types?.join(',') ?? ''].join('|');
      dispatch({ type: 'LIST_LOADED', items: res.items, nextCursor: res.next_cursor, total: res.total, cacheKey });
    }).catch(() => {
      if (!cancelled) dispatch({ type: 'LIST_ERROR', message: '加载失败' });
    });
    return () => { cancelled = true; };
  }, [effectiveScope, workId, activeType, keyword, sortField]);

  // 选中条目加载详情
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    dispatch({ type: 'DETAIL_LOADING' });
    knowledgeClient.fetchEntry(selectedId).then((detail) => {
      if (!cancelled) dispatch({ type: 'DETAIL_LOADED', detail });
    }).catch(() => {
      if (!cancelled) dispatch({ type: 'DETAIL_ERROR', message: '详情加载失败' });
    });
    return () => { cancelled = true; };
  }, [selectedId]);

  const handleScopeChange = useCallback((next: KnowledgeScope) => {
    dispatch({ type: 'SCOPE_SET', scope: next, ...(next === 'work' && urlWorkId ? { workId: urlWorkId } : {}) });
    setSelectedId(null);
    setCheckedIds(new Set());
    setActiveType('all');
    setKeyword('');
  }, [urlWorkId]);

  const handleToggleFavorite = useCallback((detail: KnowledgeEntryDetail) => {
    knowledgeClient.setEntryFlags(detail.id, { favorite: !detail.favorite }).catch(() => {
      // 静默失败，保持一致性由下次加载修正
    });
  }, []);

  // ── 录入：创建成功后刷新列表并选中新条目（方案 C §3.5） ──
  const handleCreated = useCallback((entryId: string) => {
    setCreateOpen(false);
    setSelectedId(entryId);
    dispatch({ type: 'CACHE_INVALIDATE' });
    // 触发列表重载（activeType 归位后由筛选 effect 自动拉取）
    setActiveType('all');
  }, []);

  // ── 导入导出（方案 C §3.5「Markdown 导入导出：独立面板」） ──
  const handleExport = useCallback(async (range: ExportRange) => {
    setIoLoading(true);
    setIoError(undefined);
    try {
      const res = await knowledgeClient.exportKnowledge({
        scope: effectiveScope,
        ...(effectiveScope === 'work' && workId ? { work_id: workId } : {}),
        ...(range === 'selection' ? { entry_ids: [...checkedIds] } : {}),
        format: 'markdown'
      });
      const blob = await knowledgeClient.downloadExport(res.job_id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `knowledge-export-${res.job_id}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setIoError(knowledgeErrorMessage(cause));
    } finally {
      setIoLoading(false);
    }
  }, [effectiveScope, workId, checkedIds]);

  const handleImportPreview = useCallback(async (files: File[]) => {
    setIoLoading(true);
    setIoError(undefined);
    try {
      const preview = await knowledgeClient.previewImport(files, {
        scope: effectiveScope,
        ...(effectiveScope === 'work' && workId ? { work_id: workId } : {})
      });
      setIoPreview(preview);
    } catch (cause) {
      setIoError(knowledgeErrorMessage(cause));
    } finally {
      setIoLoading(false);
    }
  }, [effectiveScope, workId]);

  const handleImportCommit = useCallback(async (opts: { preview_id: string; policy: KnowledgeConflictPolicy }) => {
    setIoCommitting(true);
    setIoError(undefined);
    try {
      await knowledgeClient.commitImport(opts);
      setIoOpen(false);
      setIoPreview(undefined);
      setSelectedId(null);
      dispatch({ type: 'CACHE_INVALIDATE' });
      setActiveType('all');
    } catch (cause) {
      setIoError(knowledgeErrorMessage(cause));
    } finally {
      setIoCommitting(false);
    }
  }, []);

  // ── 整库备份 / 恢复（方案 C §3.5） ──
  const handleBackup = useCallback(async () => {
    setBackupLoading(true);
    setBackupError(undefined);
    try {
      const res = await knowledgeClient.createBackup({
        scope: effectiveScope,
        ...(effectiveScope === 'work' && workId ? { work_id: workId } : {})
      });
      const blob = await knowledgeClient.downloadBackup(res.job_id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `knowledge-backup-${res.job_id}.json.gz`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setBackupError(knowledgeErrorMessage(cause));
    } finally {
      setBackupLoading(false);
    }
  }, [effectiveScope, workId]);

  const handleRestorePreview = useCallback(async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setBackupLoading(true);
    setBackupError(undefined);
    try {
      const preview = await knowledgeClient.previewRestore(file);
      setBackupPreview(preview);
    } catch (cause) {
      setBackupError(knowledgeErrorMessage(cause));
    } finally {
      setBackupLoading(false);
    }
  }, []);

  const handleRestoreCommit = useCallback(async (opts: { preview_id: string; policy: KnowledgeConflictPolicy }) => {
    setBackupCommitting(true);
    setBackupError(undefined);
    try {
      await knowledgeClient.commitRestore(opts);
      setBackupOpen(false);
      setBackupPreview(undefined);
      setSelectedId(null);
      dispatch({ type: 'CACHE_INVALIDATE' });
      setActiveType('all');
    } catch (cause) {
      setBackupError(knowledgeErrorMessage(cause));
    } finally {
      setBackupCommitting(false);
    }
  }, []);

  // ── 批量删除：软删除选中条目（方案 C §3.4） ──
  const handleBatchDelete = useCallback(async () => {
    if (checkedIds.size === 0) return;
    setDeleteBusy(true);
    setDeleteError(undefined);
    const ids = [...checkedIds];
    const failed: Array<{ id: string; message: string }> = [];
    for (const id of ids) {
      try {
        await knowledgeClient.removeEntry(id);
      } catch (cause) {
        failed.push({ id, message: knowledgeErrorMessage(cause) });
      }
    }
    setDeleteBusy(false);
    if (failed.length > 0) {
      const first = failed[0];
      const firstMsg = first?.message ?? '未知错误';
      setDeleteError(`部分条目删除失败（${failed.length}/${ids.length}）：${firstMsg}`);
      setCheckedIds(new Set(ids.filter((id) => failed.some((f) => f.id === id))));
      return;
    }
    setDeleteOpen(false);
    setCheckedIds(new Set());
    if (selectedId && ids.includes(selectedId)) setSelectedId(null);
    dispatch({ type: 'CACHE_INVALIDATE' });
    setActiveType('all');
  }, [checkedIds, selectedId]);

  const typeCounts = useMemo(() => {
    const counts: Record<KnowledgeEntryType, number> = { article: 0, paper: 0, novel: 0, inspiration: 0, setting: 0 };
    for (const item of state.items) counts[item.entry_type] += 1;
    return counts;
  }, [state.items]);

  return (
    <main className="kb-mgr" aria-label="知识库管理中心">
      {/* Header */}
      <header className="kb-mgr__header">
        <h1 className="kb-mgr__title">知识库管理中心</h1>
        <div className="kb-mgr__header-spacer" />
        <div className="kb-mgr__scope" role="group" aria-label="库切换">
          <button
            type="button"
            className={`kb-mgr__scope-btn${effectiveScope === 'global' ? ' kb-mgr__scope-btn--active' : ''}`}
            onClick={() => handleScopeChange('global')}
          >
            全局库
          </button>
          <button
            type="button"
            className={`kb-mgr__scope-btn${effectiveScope === 'work' ? ' kb-mgr__scope-btn--active' : ''}`}
            onClick={() => handleScopeChange('work')}
            disabled={!urlWorkId}
          >
            当前作品
          </button>
        </div>
        <input
          type="search"
          className="kb-mgr__header-search"
          placeholder="全局搜索关键词…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          aria-label="搜索知识条目"
        />
        <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>录入</Button>
        <Button variant="secondary" size="sm" onClick={() => setIoOpen(true)}>导入/导出</Button>
        <Button variant="secondary" size="sm" onClick={() => setBackupOpen(true)}>整库备份</Button>
      </header>

      {/* 录入弹窗（方案 C §3.5：统一录入弹窗） */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="录入知识条目">
        <EntryCreate scope={effectiveScope} {...(effectiveScope === 'work' && workId ? { workId } : {})} onCreated={handleCreated} />
      </Modal>

      {/* Markdown 导入导出面板（方案 C §3.5） */}
      <Modal open={ioOpen} onClose={() => setIoOpen(false)} title="导入 / 导出 Markdown">
        <ImportExport
          scope={effectiveScope}
          onExport={handleExport}
          onImportPreview={handleImportPreview}
          onImportCommit={handleImportCommit}
          loading={ioLoading}
          committing={ioCommitting}
          {...(ioPreview ? { preview: ioPreview } : {})}
          {...(ioError ? { error: ioError } : {})}
        />
      </Modal>

      {/* 整库备份 / 恢复面板（方案 C §3.5） */}
      <Modal open={backupOpen} onClose={() => setBackupOpen(false)} title="整库备份 / 恢复">
        <BackupPanel
          scope={effectiveScope}
          onBackup={handleBackup}
          onRestorePreview={handleRestorePreview}
          onRestoreCommit={handleRestoreCommit}
          loading={backupLoading}
          committing={backupCommitting}
          {...(backupPreview ? { restorePreview: backupPreview } : {})}
          {...(backupError ? { error: backupError } : {})}
        />
      </Modal>

      {/* 批量删除确认（方案 C §3.4） */}
      <Modal open={deleteOpen} onClose={() => !deleteBusy && setDeleteOpen(false)} title="确认删除选中条目">
        <div className="kb-mgr__delete-dialog">
          <p className="kb-mgr__delete-text">
            确定删除已选中的 <strong>{checkedIds.size}</strong> 条知识条目吗？
            删除为软删除，可在回收站恢复。
          </p>
          {deleteError && <p className="kb-mgr__delete-error" role="alert">{deleteError}</p>}
          <div className="kb-mgr__delete-actions">
            <Button variant="ghost" size="sm" onClick={() => setDeleteOpen(false)} disabled={deleteBusy}>保留</Button>
            <Button variant="danger" size="sm" onClick={() => { void handleBatchDelete(); }} loading={deleteBusy}>
              {deleteBusy ? '删除中…' : '确认删除'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* 主体三栏 */}
      <div className="kb-mgr__body">
        {/* 左导航 */}
        <nav className={`kb-mgr__nav${navCollapsed ? ' kb-mgr__nav--collapsed' : ''}`} aria-label="知识库导航">
          <button
            type="button"
            className="kb-mgr__nav-toggle"
            onClick={() => setNavCollapsed((v) => !v)}
            aria-label={navCollapsed ? '展开导航' : '收起导航'}
          >
            {navCollapsed ? '»' : '«'}
          </button>
          {!navCollapsed && (
            <>
              <div className="kb-mgr__nav-section">
                <p className="kb-mgr__nav-heading">类型筛选</p>
                <div className="kb-mgr__type-list">
                  <button
                    type="button"
                    className={`kb-mgr__type-item${activeType === 'all' ? ' kb-mgr__type-item--active' : ''}`}
                    onClick={() => setActiveType('all')}
                  >
                    全部 <span className="kb-mgr__type-count">{state.total}</span>
                  </button>
                  {ALL_TYPES.map((type) => (
                    <button
                      key={type}
                      type="button"
                      className={`kb-mgr__type-item${activeType === type ? ' kb-mgr__type-item--active' : ''}`}
                      onClick={() => setActiveType(type)}
                    >
                      {TYPE_META[type].label}
                      <span className="kb-mgr__type-count">{typeCounts[type]}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="kb-mgr__nav-section">
                <p className="kb-mgr__nav-heading">标签</p>
                {tags.length > 0 ? (
                  <div className="kb-mgr__tag-cloud">
                    {tags.slice(0, 20).map((tag) => (
                      <button
                        key={tag.id}
                        type="button"
                        className="kb-mgr__tag-chip"
                        title={`${tag.name} (${tag.entry_count})`}
                      >
                        {tag.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="kb-mgr__nav-empty">暂无标签</p>
                )}
              </div>
              <div className="kb-mgr__nav-section">
                <p className="kb-mgr__nav-heading">收藏与置顶</p>
                <p className="kb-mgr__nav-empty">收藏与置顶条目将在此快捷展示</p>
              </div>
            </>
          )}
        </nav>

        {/* 中间列表 */}
        <section className="kb-mgr__list" aria-label="知识条目列表">
          <div className="kb-mgr__toolbar">
            <input
              type="search"
              className="kb-mgr__toolbar-search"
              placeholder="关键词搜索…"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              aria-label="列表关键词"
            />
            <select
              className="kb-mgr__select"
              value={activeType}
              onChange={(e) => setActiveType(e.target.value as KnowledgeEntryType | 'all')}
              aria-label="类型多选"
            >
              <option value="all">全部类型</option>
              {ALL_TYPES.map((t) => <option key={t} value={t}>{TYPE_META[t].label}</option>)}
            </select>
            <select
              className="kb-mgr__select"
              value={sortField}
              onChange={(e) => setSortField(e.target.value as SortField)}
              aria-label="排序"
            >
              <option value="updated_at">按更新时间</option>
              <option value="created_at">按创建时间</option>
              <option value="title">按标题</option>
            </select>
            <span className="kb-mgr__type-count">共 {state.total} 条</span>
          </div>

          {checkedIds.size > 0 && (
            <div className="kb-mgr__batch" role="toolbar" aria-label="批量操作">
              <span className="kb-mgr__batch-count">已选 {checkedIds.size} 条</span>
              <Button variant="secondary" size="sm" onClick={() => { void handleExport('selection'); }}>导出选中</Button>
              <Button variant="danger" size="sm" onClick={() => { setDeleteError(undefined); setDeleteOpen(true); }}>删除</Button>
              <Button variant="ghost" size="sm" onClick={() => setCheckedIds(new Set())}>取消</Button>
            </div>
          )}

          {state.loading ? (
            <div className="kb-mgr__state" role="status">
              <Spinner label="正在加载知识条目…" />
            </div>
          ) : state.items.length === 0 ? (
            <div className="kb-mgr__state">
              <p className="kb-mgr__state-text">还没有知识条目，点击「录入」开始。</p>
            </div>
          ) : (
            <div className="kb-mgr__cards">
              {state.items.map((item) => (
                <EntryCard
                  key={item.id}
                  item={item}
                  selected={selectedId === item.id}
                  checked={checkedIds.has(item.id)}
                  onSelect={() => { setSelectedId(item.id); setDetailCollapsed(false); }}
                  onToggleCheck={() => {
                    setCheckedIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(item.id)) next.delete(item.id);
                      else next.add(item.id);
                      return next;
                    });
                  }}
                />
              ))}
            </div>
          )}
        </section>

        {/* 右侧详情 */}
        {!detailCollapsed ? (
          <DetailPanel
            detail={state.detail}
            loading={state.detailLoading}
            onClose={() => setDetailCollapsed(true)}
            onToggleFavorite={handleToggleFavorite}
          />
        ) : (
          <button
            type="button"
            className="kb-mgr__detail-toggle"
            onClick={() => setDetailCollapsed(false)}
            aria-label="展开详情"
            style={{ writingMode: 'vertical-rl', padding: 8 }}
          >
            « 详情
          </button>
        )}
      </div>
    </main>
  );
}
