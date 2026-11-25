// ============================================================================
// M3c-3 知识库 · 写作工作台抽屉（方案 D）
// 依据：docs/01-产品与设计/知识库工作台抽屉设计-方案D.md
//
// 职责：380px 左侧滑出抽屉，服务「边写边查、快速引用」——
//       头部（标题 + 全屏管理 →）/ 库切换（本作品·全局）/ 搜索（防抖）/
//       类型·标签 Chip 筛选 / 紧凑卡片列表 / 抽屉内简易详情 /
//       固定底部操作区（快速录入 + 导入 Markdown）。
// 与方案 C 协作：跳转全页携带 ?q=&type=&entry= 保留当前筛选；
//               两者共用 knowledgeClient 与列表缓存（CACHE_INVALIDATE 刷新）。
// 作品库隔离：workId 为唯一来源（工作台 URL 参数），scope=work 时按作品引用关系隔离。
// ============================================================================

import { forwardRef, useCallback, useEffect, useImperativeHandle, useReducer, useRef, useState } from 'react';
import { Button, Modal } from '@storyforge/ui';
import type {
  KnowledgeEntryType,
  KnowledgeImportPreviewResponse,
  KnowledgeScope,
  KnowledgeTag
} from '@storyforge/contracts';
import type { KnowledgeImportCommitResult } from './knowledge-client';
import {
  knowledgeInitialState,
  knowledgeReducer,
  knowledgeCacheKey,
  knowledgeErrorMessage,
  type KnowledgeState
} from './knowledge-state';
import { knowledgeClient } from './knowledge-client';
import { EntryCreate } from './entry-create';
import { ImportExport } from './import-export';
import { DrawerEntryCard } from './drawer-entry-card';
import { DrawerEntryPreview } from './drawer-entry-preview';
import './knowledge-drawer.css';

/** 搜索防抖时长（方案 D §3.2 关键词即时搜索） */
const SEARCH_DEBOUNCE_MS = 300;
/** 引用成功高亮时长 */
const HIGHLIGHT_MS = 1800;

const TYPE_CHIPS: Array<{ value: KnowledgeEntryType; label: string }> = [
  { value: 'article', label: '文章' },
  { value: 'paper', label: '论文' },
  { value: 'novel', label: '小说' },
  { value: 'inspiration', label: '灵感' },
  { value: 'setting', label: '设定集' }
];

type PanelMode = 'create' | 'import';

/** 命令式句柄：工作台顶部「知识库」按钮用 ref.open() 滑出抽屉 */
export interface KnowledgeDrawerHandle {
  open: () => void;
  close: () => void;
}

interface Props {
  /** 当前作品 id；为 null 时抽屉只允许全局素材库（无作品上下文） */
  workId: string | null;
  onClose?: () => void;
}

/** 抽屉内部筛选（在 knowledgeReducer 之外，供 Chip 行即时切换） */
interface DrawerFilters {
  keyword: string;
  types: KnowledgeEntryType[];
  tagIds: string[];
}

/** 抽屉筛选 → 方案 C 全页 URL（尽量保留当前筛选状态，方案 D §7） */
function buildManageHref(filters: DrawerFilters, entryId: string | null): string {
  const params = new URLSearchParams();
  if (filters.keyword.trim()) params.set('q', filters.keyword.trim());
  if (filters.types.length > 0) params.set('type', filters.types.join(','));
  if (entryId) params.set('entry', entryId);
  const qs = params.toString();
  return qs ? `/knowledge?${qs}` : '/knowledge';
}

/**
 * 写作工作台知识库抽屉（方案 D）。
 *
 * 左缘 380px 滑出，主内容区不被替换；Esc / 关闭按钮归还焦点到「知识库」触发按钮。
 */
export const KnowledgeDrawer = forwardRef<KnowledgeDrawerHandle, Props>(function KnowledgeDrawer(
  { workId, onClose },
  ref
) {
  const [state, dispatch] = useReducer(knowledgeReducer, knowledgeInitialState, (init): KnowledgeState => ({
    ...init,
    // 有作品上下文时默认「本作品」库（方案 D §4.1），否则回退全局库
    scope: workId ? 'work' : 'global',
    ...(workId ? { workId } : {})
  }));

  const [filters, setFilters] = useState<DrawerFilters>({ keyword: '', types: [], tagIds: [] });
  const [tags, setTags] = useState<KnowledgeTag[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelMode | null>(null);
  const [ioPreview, setIoPreview] = useState<KnowledgeImportPreviewResponse | null>(null);
  const [ioLoading, setIoLoading] = useState(false);
  const [ioError, setIoError] = useState<string | null>(null);
  const [ioCommitting, setIoCommitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [referencedId, setReferencedId] = useState<string | null>(null);
  const [referencingId, setReferencingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /** dialog 是否处于打开态（打开后才拉列表 / 标签，关闭后停止请求） */
  const [opened, setOpened] = useState(false);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const debounceTimer = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);
  const highlightTimer = useRef<number | null>(null);

  useImperativeHandle(ref, () => ({
    open() {
      const dialog = dialogRef.current;
      if (!dialog || dialog.open) return;
      dialog.showModal();
      setOpened(true);
    },
    close() {
      dialogRef.current?.close();
    }
  }), []);

  const handleDialogClose = useCallback(() => {
    setOpened(false);
    onClose?.();
  }, [onClose]);

  /** scope 回退口径与方案 C 一致：无作品上下文时 work 回退 global */
  const activeScope: KnowledgeScope = state.scope === 'work' && !workId ? 'global' : state.scope;

  useEffect(() => () => {
    if (debounceTimer.current) window.clearTimeout(debounceTimer.current);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  /** 按当前筛选加载列表（复用 T28 列表缓存，避免重复请求） */
  const loadList = useCallback((opts?: { append?: boolean }) => {
    const cacheKey = knowledgeCacheKey({
      scope: activeScope,
      ...(workId ? { workId } : {}),
      keyword: filters.keyword,
      types: filters.types,
      tagIds: filters.tagIds
    });
    const cached = state.listCache[cacheKey];
    if (!opts?.append && cached) {
      setListError(null);
      dispatch({ type: 'LIST_LOADED', items: cached.items, nextCursor: cached.nextCursor, total: cached.total, cacheKey });
      return;
    }
    dispatch({ type: 'LIST_LOADING' });
    setListError(null);
    knowledgeClient.listEntries({
      scope: activeScope,
      ...(activeScope === 'work' && workId ? { work_id: workId } : {}),
      ...(filters.keyword ? { keyword: filters.keyword } : {}),
      ...(filters.types.length > 0 ? { types: filters.types } : {}),
      ...(filters.tagIds.length > 0 ? { tag_ids: filters.tagIds } : {}),
      ...(opts?.append && state.nextCursor ? { cursor: state.nextCursor } : {}),
      limit: 50
    }).then((res) => {
      const items = opts?.append ? [...state.items, ...res.items] : res.items;
      dispatch({ type: 'LIST_LOADED', items, nextCursor: res.next_cursor, total: res.total, cacheKey });
    }).catch((cause: unknown) => {
      setListError(knowledgeErrorMessage(cause));
      dispatch({ type: 'LIST_LOADED', items: [], nextCursor: null, total: 0, cacheKey });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScope, workId, filters, state.listCache, state.nextCursor, state.items]);

  // 首次打开或筛选变化时加载列表
  useEffect(() => {
    if (opened) loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, activeScope, workId, filters.keyword, filters.types.join(','), filters.tagIds.join(',')]);

  // 标签云（Chip 行数据源；失败不阻断检索）
  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    knowledgeClient.listTags({
      scope: activeScope,
      ...(activeScope === 'work' && workId ? { work_id: workId } : {})
    }).then((result) => {
      if (!cancelled) setTags(result);
    }).catch(() => {
      if (!cancelled) setTags([]);
    });
    return () => { cancelled = true; };
  }, [activeScope, workId]);

  const loadDetail = useCallback((entryId: string) => {
    dispatch({ type: 'DETAIL_LOADING' });
    knowledgeClient.fetchEntry(entryId, activeScope === 'work' && workId ? { workId } : {}).then((detail) => {
      dispatch({ type: 'DETAIL_LOADED', detail });
    }).catch((cause: unknown) => {
      dispatch({ type: 'DETAIL_ERROR', message: knowledgeErrorMessage(cause), cause });
    });
  }, [activeScope, workId]);

  /** 搜索防抖：输入后 300ms 才应用关键词筛选 */
  const handleKeywordChange = useCallback((value: string) => {
    if (debounceTimer.current) window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => {
      setFilters((prev) => (prev.keyword === value ? prev : { ...prev, keyword: value }));
    }, SEARCH_DEBOUNCE_MS);
  }, []);

  const handleSelect = useCallback((entryId: string) => {
    setSelectedId(entryId);
    loadDetail(entryId);
  }, [loadDetail]);

  const closePreview = useCallback(() => {
    setSelectedId(null);
  }, []);

  /** 一键引用到当前作品（≤2 次点击）：成功后 Toast + 卡片短暂高亮 */
  const handleReference = useCallback((entryId: string) => {
    if (!workId) {
      setFormError('当前没有作品上下文，无法引用。');
      return;
    }
    setReferencingId(entryId);
    setFormError(null);
    knowledgeClient.createRefs(workId, { entry_ids: [entryId] }).then(() => {
      setReferencedId(entryId);
      showToast('已引用');
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
      highlightTimer.current = window.setTimeout(() => setReferencedId(null), HIGHLIGHT_MS);
    }).catch((cause: unknown) => {
      setFormError(knowledgeErrorMessage(cause));
    }).finally(() => {
      setReferencingId(null);
    });
  }, [workId, showToast]);

  const handleScopeChange = useCallback((scope: KnowledgeScope) => {
    if (scope === 'work' && !workId) return;
    dispatch({ type: 'SCOPE_SET', scope, ...(scope === 'work' && workId ? { workId } : {}) });
    setSelectedId(null);
    setFilters((prev) => ({ ...prev, tagIds: [] }));
  }, [workId]);

  const toggleType = useCallback((value: KnowledgeEntryType) => {
    setFilters((prev) => ({
      ...prev,
      types: prev.types.includes(value)
        ? prev.types.filter((item) => item !== value)
        : [...prev.types, value]
    }));
  }, []);

  const toggleTag = useCallback((tagId: string) => {
    setFilters((prev) => ({
      ...prev,
      tagIds: prev.tagIds.includes(tagId)
        ? prev.tagIds.filter((item) => item !== tagId)
        : [...prev.tagIds, tagId]
    }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({ keyword: '', types: [], tagIds: [] });
  }, []);

  const hasFilter = filters.types.length > 0 || filters.tagIds.length > 0 || filters.keyword !== '';

  const openPanel = useCallback((mode: PanelMode) => {
    setIoPreview(null);
    setIoError(null);
    setFormError(null);
    setPanel(mode);
  }, []);

  const closePanel = useCallback(() => {
    setPanel(null);
    setIoPreview(null);
    setIoError(null);
    setFormError(null);
  }, []);

  /** 录入 / 导入后刷新列表（清缓存 + 重拉） */
  const refreshAfterChange = useCallback(() => {
    dispatch({ type: 'CACHE_INVALIDATE' });
    window.setTimeout(() => loadList(), 0);
  }, [loadList]);

  /** 跳转方案 C 全页（携带当前筛选；深度管理走全页） */
  const openFullManager = useCallback((entryId: string | null) => {
    onClose?.();
    window.open(buildManageHref(filters, entryId), '_blank');
  }, [filters, onClose]);

  const detailOpen = selectedId !== null && (state.detailLoading || state.detail !== null);
  const detailError = state.detailError instanceof Error ? state.detailError.message : null;

  return (
    <>
      <dialog ref={dialogRef} className="kb-drawer" aria-labelledby="kb-drawer-title" onClose={handleDialogClose}>
        {/* 头部：标题 + 关闭 + 全屏管理 → */}
        <div className="kb-drawer__header">
          <h2 id="kb-drawer-title" className="kb-drawer__title">知识库</h2>
          <div className="kb-drawer__actions">
            <Button variant="ghost" size="sm" onClick={() => dialogRef.current?.close()}>关闭知识库</Button>
            <Button variant="ghost" size="sm" onClick={() => openFullManager(selectedId)}>全屏管理 →</Button>
          </div>
        </div>

        {/* 库切换：本作品（当前作品引用关系）/ 全局素材库 */}
        <div className="kb-drawer__lib">
          <div className="kb-drawer__tabs" role="tablist" aria-label="知识库切换">
            {workId && (
              <button
                type="button"
                role="tab"
                className="kb-drawer__tab"
                aria-selected={activeScope === 'work'}
                onClick={() => handleScopeChange('work')}
              >
                本作品
              </button>
            )}
            <button
              type="button"
              role="tab"
              className="kb-drawer__tab"
              aria-selected={activeScope === 'global'}
              onClick={() => handleScopeChange('global')}
            >
              全局库
            </button>
          </div>
        </div>

        {/* 搜索（防抖） */}
        <div className="kb-drawer__search">
          <input
            type="search"
            className="kb-drawer__search-field"
            placeholder="搜索标题 / 正文 / 标签"
            aria-label="搜索知识条目"
            disabled={state.loading}
            onChange={(event) => handleKeywordChange(event.target.value)}
          />
        </div>

        {/* 类型 / 标签 Chip 筛选（可一键清除） */}
        <div className="kb-drawer__filters" aria-label="筛选条件">
          {TYPE_CHIPS.map((chip) => (
            <button
              key={chip.value}
              type="button"
              className="kb-drawer__chip"
              aria-pressed={filters.types.includes(chip.value)}
              onClick={() => toggleType(chip.value)}
            >
              {chip.label}
            </button>
          ))}
          {tags.slice(0, 6).map((tag) => (
            <button
              key={tag.id}
              type="button"
              className="kb-drawer__chip"
              aria-pressed={filters.tagIds.includes(tag.id)}
              onClick={() => toggleTag(tag.id)}
            >
              #{tag.name}
              <span className="kb-drawer__chip-count">{tag.entry_count}</span>
            </button>
          ))}
          {hasFilter && (
            <button type="button" className="kb-drawer__clear" onClick={clearFilters}>清除</button>
          )}
        </div>

        {/* 紧凑卡片列表 */}
        <div className="kb-drawer__list" data-work-id={workId ?? ''}>
          {state.loading ? (
            <>
              <div className="kb-drawer__skeleton" aria-hidden="true" />
              <div className="kb-drawer__skeleton" aria-hidden="true" />
              <div className="kb-drawer__state" role="status">正在加载…</div>
            </>
          ) : listError ? (
            <div className="kb-drawer__state" role="alert">
              <p>{listError}</p>
              <Button variant="secondary" size="sm" onClick={() => loadList()}>重试</Button>
            </div>
          ) : state.items.length === 0 ? (
            <div className="kb-drawer__state">
              <p>{activeScope === 'work' ? '本作品暂无引用知识' : '全局库为空'}</p>
              <p className="kb-drawer__state-role">用底部「快速录入」加一条素材。</p>
            </div>
          ) : (
            <>
              <div className="kb-drawer__list-head">
                <span>共 {state.total} 条</span>
                <span>最近更新优先</span>
              </div>
              {state.items.map((item) => (
                <DrawerEntryCard
                  key={item.id}
                  entry={item}
                  current={selectedId === item.id}
                  referenced={referencedId === item.id}
                  onSelect={handleSelect}
                  onReference={handleReference}
                />
              ))}
              {state.nextCursor && (
                <div className="kb-drawer__more">
                  <Button variant="ghost" size="sm" onClick={() => loadList({ append: true })}>加载更多</Button>
                </div>
              )}
            </>
          )}
          {formError && <p className="kb-drawer__state" role="alert">{formError}</p>}
        </div>

        {/* 抽屉内简易详情（不跳全页） */}
        {detailOpen && (
          <DrawerEntryPreview
            detail={state.detail}
            loading={state.detailLoading}
            error={detailError}
            canReference={Boolean(workId)}
            referencing={referencingId === selectedId}
            onClose={closePreview}
            onReference={() => selectedId && handleReference(selectedId)}
            onOpenFull={() => selectedId && openFullManager(selectedId)}
            onEdit={() => selectedId && openFullManager(selectedId)}
          />
        )}

        {/* 固定底部操作区 */}
        <div className="kb-drawer__footer">
          <Button variant="primary" size="sm" onClick={() => openPanel('create')}>+ 快速录入</Button>
          <Button variant="secondary" size="sm" onClick={() => openPanel('import')}>导入 Markdown</Button>
        </div>
      </dialog>

      {/* 快速录入：轻量面板（粘贴文本 + 类型选择） */}
      {panel === 'create' && (
        <Modal open onClose={closePanel} title="快速录入知识">
          <EntryCreate
            scope={activeScope}
            {...(workId ? { workId } : {})}
            onCreated={() => {
              closePanel();
              showToast('已入库');
              refreshAfterChange();
            }}
            onError={setFormError}
          />
        </Modal>
      )}

      {/* 导入 Markdown：文件选择 → 预览（冲突策略） → 提交 */}
      {panel === 'import' && (
        <Modal open onClose={closePanel} title="导入 Markdown">
          <ImportExport
            scope={activeScope}
            {...(ioPreview !== null ? { preview: ioPreview } : {})}
            loading={ioLoading}
            {...(ioError ? { error: ioError } : {})}
            committing={ioCommitting}
            onImportPreview={(files) => {
              setIoLoading(true);
              setIoError(null);
              knowledgeClient.previewImport(files, {
                scope: activeScope,
                ...(activeScope === 'work' && workId ? { work_id: workId } : {})
              }).then((res) => {
                setIoPreview(res);
              }).catch((cause: unknown) => {
                setIoError(knowledgeErrorMessage(cause));
              }).finally(() => {
                setIoLoading(false);
              });
            }}
            onImportCommit={(opts) => {
              setIoCommitting(true);
              setIoError(null);
              knowledgeClient.commitImport(opts).then((res: KnowledgeImportCommitResult) => {
                showToast(`导入完成：新增 ${res.result.created} 条`);
                closePanel();
                refreshAfterChange();
              }).catch((cause: unknown) => {
                setIoError(knowledgeErrorMessage(cause));
              }).finally(() => {
                setIoCommitting(false);
              });
            }}
          />
        </Modal>
      )}

      {/* 引用成功 / 入库成功 Toast */}
      {toast && (
        <div className="kb-drawer__toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </>
  );
});