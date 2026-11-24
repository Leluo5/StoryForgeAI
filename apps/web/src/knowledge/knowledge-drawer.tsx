import { forwardRef, useCallback, useEffect, useImperativeHandle, useReducer, useRef } from 'react';
import { Button } from '@storyforge/ui';
import type { KnowledgeScope } from '@storyforge/contracts';
import { knowledgeInitialState, knowledgeReducer, knowledgeCacheKey, knowledgeErrorMessage, type KnowledgeState } from './knowledge-state';
import { knowledgeClient } from './knowledge-client';
import { KnowledgeTabs, type KnowledgeTabItem } from './knowledge-tabs';
import { KnowledgeSearchBar } from './knowledge-search-bar';
import { EntryList } from './entry-list';
import { EntryDetail } from './entry-detail';
import type { ApiError } from '../api/client';

export interface KnowledgeDrawerHandle {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
}

interface Props {
  /** 当前作品 id；为 null 时抽屉只允许全局素材库（无作品上下文） */
  workId: string | null;
  onClose?: () => void;
}

const GLOBAL_TAB: KnowledgeTabItem = { scope: 'global', label: '知识库' };

/** 从 ApiError 提取版本冲突信息（409 VERSION_CONFLICT 的 details.current_version） */
function extractVersionConflict(cause: unknown): { currentVersion: number } | null {
  if (cause instanceof Error && 'status' in cause) {
    const err = cause as unknown as ApiError & { details?: { current_version?: number } };
    if (err.status === 409 && err.details && typeof err.details.current_version === 'number') {
      return { currentVersion: err.details.current_version };
    }
  }
  return null;
}

/**
 * 知识库抽屉浮层（M3c-3 T29~T31）。
 *
 * 原生 `<dialog>` 浮层：showModal() 打开，不改三栏宽度，关闭后焦点归还触发按钮，
 * 正文编辑器保持挂载（D01）。T30 填充两库页签 + 检索栏；T31 接入列表与详情，
 * 数据走 T28 缓存（listEntries/getEntry），无限滚动 + 版本冲突提示。
 */
export const KnowledgeDrawer = forwardRef<KnowledgeDrawerHandle, Props>(function KnowledgeDrawer(
  { workId, onClose },
  ref
) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, dispatch] = useReducer(knowledgeReducer, knowledgeInitialState,
    (init): KnowledgeState => ({ ...init, scope: 'global', ...(workId ? { workId } : {}) }));

  const tabs: KnowledgeTabItem[] = workId
    ? [GLOBAL_TAB, { scope: 'work', label: '作品库' }]
    : [GLOBAL_TAB];

  const activeScope: KnowledgeScope = state.scope === 'work' && !workId ? 'global' : state.scope;

  const loadList = useCallback((opts?: { append?: boolean }) => {
    const cacheKey = knowledgeCacheKey({ scope: activeScope, ...(workId ? { workId } : {}), keyword: state.keyword });
    const cached = state.listCache[cacheKey];
    if (!opts?.append && cached && !state.loading) {
      dispatch({ type: 'LIST_LOADED', items: cached.items, nextCursor: cached.nextCursor, total: cached.total, cacheKey });
      return;
    }
    dispatch({ type: 'LIST_LOADING' });
    const query = {
      scope: activeScope,
      ...(activeScope === 'work' && workId ? { work_id: workId } : {}),
      ...(state.keyword ? { keyword: state.keyword } : {}),
      ...(opts?.append && state.nextCursor ? { cursor: state.nextCursor } : {}),
      limit: 50
    };
    void knowledgeClient.listEntries(query).then((res) => {
      const items = opts?.append ? [...state.items, ...res.items] : res.items;
      dispatch({
        type: 'LIST_LOADED',
        items,
        nextCursor: res.next_cursor,
        total: res.total,
        cacheKey: knowledgeCacheKey({ scope: activeScope, ...(workId ? { workId } : {}), keyword: state.keyword })
      });
    }).catch((cause) => {
      dispatch({ type: 'LIST_ERROR', message: knowledgeErrorMessage(cause) });
    });
  }, [activeScope, workId, state.keyword, state.nextCursor, state.loading, state.listCache, state.items]);

  // 首次打开或库/关键词变化时加载列表
  useEffect(() => {
    if (dialogRef.current?.open) loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScope, state.keyword]);

  const loadDetail = useCallback((entryId: string) => {
    dispatch({ type: 'DETAIL_LOADING' });
    void knowledgeClient.fetchEntry(entryId, activeScope === 'work' && workId ? { workId } : {}).then((detail) => {
      dispatch({ type: 'DETAIL_LOADED', detail });
    }).catch((cause: unknown) => {
      dispatch({ type: 'DETAIL_ERROR', message: knowledgeErrorMessage(cause), cause });
    });
  }, [activeScope, workId]);

  const handleScopeChange = useCallback((scope: KnowledgeScope) => {
    dispatch({ type: 'SCOPE_SET', scope, ...(scope === 'work' && workId ? { workId } : {}) });
    dispatch({ type: 'DETAIL_LOADING' });
  }, [workId]);

  const handleSearch = useCallback((keyword: string) => {
    dispatch({ type: 'FILTER_SET', keyword });
  }, []);

  const handleSelect = useCallback((entryId: string) => {
    loadDetail(entryId);
  }, [loadDetail]);

  const handleLoadMore = useCallback(() => {
    if (state.nextCursor) loadList({ append: true });
  }, [state.nextCursor, loadList]);

  const versionConflict = extractVersionConflict(state.detailError);

  useImperativeHandle(ref, () => ({
    open: () => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.open) return;
      dialog.showModal();
      dialog.querySelector<HTMLElement>('button, a, input')?.focus();
      loadList();
    },
    close: () => dialogRef.current?.close(),
    isOpen: () => dialogRef.current?.open ?? false
  }), [loadList]);

  return (
    <dialog
      ref={dialogRef}
      className="knowledge-drawer"
      aria-labelledby="knowledge-drawer-title"
      onClose={onClose}
    >
      <div className="knowledge-drawer__header">
        <h2 id="knowledge-drawer-title">知识库</h2>
        <Button variant="ghost" size="sm" onClick={() => dialogRef.current?.close()}>关闭知识库</Button>
      </div>
      <KnowledgeTabs value={activeScope} items={tabs} onChange={handleScopeChange} />
      <KnowledgeSearchBar initialValue={state.keyword} onSearch={handleSearch} disabled={state.loading} />
      <div className="knowledge-drawer__body" data-work-id={workId ?? ''}>
        <div className="knowledge-drawer__split">
          <div className="knowledge-drawer__list">
            <EntryList
              items={state.items}
              total={state.total}
              loading={state.loading}
              selectedEntryId={state.selectedEntryId}
              hasMore={Boolean(state.nextCursor)}
              onSelect={handleSelect}
              onLoadMore={handleLoadMore}
            />
          </div>
          <div className="knowledge-drawer__detail">
            <EntryDetail
              detail={state.detail}
              loading={state.detailLoading}
              versionConflict={versionConflict}
              onReload={() => state.detail && loadDetail(state.detail.id)}
            />
          </div>
        </div>
      </div>
    </dialog>
  );
});
