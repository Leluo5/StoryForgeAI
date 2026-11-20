import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import type { CharacterBoardResponse, CharacterView } from '@storyforge/contracts';
import { characterClient, type CharacterClient } from './character-client';
import {
  CharacterStoreContext,
  characterErrorMessage,
  filterCharacters,
  toBoardData,
  useCharacterStore,
  type CharacterBoardData,
  type CharacterFilters,
  type CharacterPositionUpdate
} from './character-state';
import { autoCharacterLayout, characterLayoutBounds, clampCharacterPosition } from './character-layout';
import {
  CharacterToolbar,
  CHARACTER_FILTER_DIMENSIONS,
  type CharacterDimensionOption,
  type CharacterFilterDimension,
  type CharacterViewMode
} from './character-toolbar';
import { CharacterCanvas } from './character-canvas';
import { CharacterList } from './character-list';
import { CharacterArchiveView } from './character-archive-view';
import { CharacterAnchorPanel } from './character-anchor-panel';

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
const DEFAULT_PAN = { x: 40, y: 40 };

interface ProviderProps {
  workId: string;
  enabled?: boolean;
  client?: CharacterClient;
  children: ReactNode;
}

function clampZoom(value: number): number {
  if (value < ZOOM_MIN) return ZOOM_MIN;
  if (value > ZOOM_MAX) return ZOOM_MAX;
  return Number(value.toFixed(2));
}

/** 角色版图状态容器：board 一次读全 + 筛选 + 批量布局提交 + 409 冲突提示（T33） */
export function CharacterStoreProvider({ workId, enabled = true, client = characterClient, children }: ProviderProps): JSX.Element {
  const [board, setBoard] = useState<CharacterBoardData | null>(null);
  const [views, setViews] = useState<CharacterView[]>([]);
  const [viewId, setViewIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filters, setFilters] = useState<CharacterFilters>({});
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null);
  const [lastLayoutSnapshot] = useState<CharacterPositionUpdate[] | null>(null);

  const viewIdRef = useRef<string | null>(null);
  viewIdRef.current = viewId;
  const loadedRef = useRef(false);

  const fetchBoard = useCallback(async (targetViewId: string) => {
    const response = await client.getBoard(workId, targetViewId);
    setBoard(toBoardData(response));
    setViewIdState(targetViewId);
  }, [client, workId]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const allViews = await client.listViews(workId);
      setViews(allViews);
      const target = viewIdRef.current ?? allViews.find((view) => view.is_default)?.id ?? allViews[0]?.id ?? null;
      if (!target) {
        setBoard(null);
        return;
      }
      await fetchBoard(target);
    } catch (cause) {
      setError(characterErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [client, workId, fetchBoard]);

  useEffect(() => {
    if (!enabled || loadedRef.current) return;
    loadedRef.current = true;
    void reload();
  }, [enabled, reload]);

  const setViewId = useCallback((next: string | null) => {
    viewIdRef.current = next;
    setViewIdState(next);
    if (!next) return;
    setLoading(true);
    setError('');
    client.getBoard(workId, next)
      .then((response) => setBoard(toBoardData(response)))
      .catch((cause) => setError(characterErrorMessage(cause)))
      .finally(() => setLoading(false));
  }, [client, workId]);

  const saveLayout = useCallback(async (updates: CharacterPositionUpdate[]): Promise<boolean> => {
    if (updates.length === 0 || !viewIdRef.current) return false;
    setBusy(true);
    setError('');
    try {
      const positions = updates.map((update) => ({
        character_id: update.character_id,
        x: clampCharacterPosition(update.x),
        y: clampCharacterPosition(update.y),
        arranged: true as const
      }));
      await client.updateLayout(workId, viewIdRef.current, positions);
      setBoard((prev) => {
        if (!prev) return prev;
        const byId = new Map(updates.map((update) => [update.character_id, update]));
        const nextLayout = prev.layout.map((entry) => {
          const update = byId.get(entry.character_id);
          return update
            ? { ...entry, x: clampCharacterPosition(update.x), y: clampCharacterPosition(update.y), arranged: true }
            : entry;
        });
        for (const update of updates) {
          if (!prev.layout.some((entry) => entry.character_id === update.character_id)) {
            nextLayout.push({
              character_id: update.character_id,
              x: clampCharacterPosition(update.x),
              y: clampCharacterPosition(update.y),
              arranged: true,
              sort_index: prev.layout.length
            });
          }
        }
        return { ...prev, layout: nextLayout };
      });
      return true;
    } catch (cause) {
      setError(characterErrorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }, [client, workId]);

  const filterBoardCharacters = useCallback((): CharacterBoardResponse['characters'] => {
    return board ? filterCharacters(board.characters, filters) : [];
  }, [board, filters]);

  const store = {
    workId,
    client,
    viewId,
    board,
    views,
    loading,
    busy,
    error,
    notice,
    filters,
    selectedCharacterId,
    selectedRelationId,
    lastLayoutSnapshot,
    setError,
    setNotice,
    setFilters,
    selectCharacter: (characterId: string | null) => {
      setSelectedCharacterId(characterId);
      setSelectedRelationId(null);
    },
    selectRelation: (relationId: string | null) => {
      setSelectedRelationId(relationId);
      setSelectedCharacterId(null);
    },
    setViewId,
    reload,
    filterBoardCharacters,
    saveLayout
  };

  return <CharacterStoreContext.Provider value={store}>{children}</CharacterStoreContext.Provider>;
}

function deriveDimensionOptions(
  characters: CharacterBoardResponse['characters']
): Record<CharacterFilterDimension, CharacterDimensionOption[]> {
  const buckets: Record<CharacterFilterDimension, Set<string>> = {
    country_region: new Set(),
    faith: new Set(),
    faction: new Set(),
    race: new Set(),
    occupation: new Set(),
    age_band: new Set()
  };
  for (const character of characters) {
    for (const dim of CHARACTER_FILTER_DIMENSIONS) {
      const value = character.six_dim[dim.key];
      if (value) buckets[dim.key].add(value);
    }
  }
  const result = {} as Record<CharacterFilterDimension, CharacterDimensionOption[]>;
  for (const dim of CHARACTER_FILTER_DIMENSIONS) {
    result[dim.key] = [...buckets[dim.key]].sort((a, b) => a.localeCompare(b)).map((value) => ({ value, label: value }));
  }
  return result;
}

interface CharacterBoardProps {
  /** 列表/画布共用的「打开角色详情」回调，T35 起接入右侧角色面板 */
  onOpenCharacter?: ((characterId: string) => void) | undefined;
  /** 归档完成后同步深链（右侧面板跟随到该角色） */
  onArchiveRequest?: ((characterId: string) => void) | undefined;
  /** 章节列表：归档影响说明的命中段落按章节读取（T38） */
  chapters?: { id: string; title: string }[] | undefined;
}

interface ArchiveFlow {
  characterId: string;
  name: string;
  impact: { relations: number; growth_events: number; chapters: number; exclusive_plot_nodes: number };
  scan: { status: 'pending' | 'running' | 'succeeded' | 'failed'; total_chapters: number };
}

/** 角色版图主视图：工具栏 + 画布/列表/归档，持有缩放与平移本地状态（T33 / T34 / T38） */
function CharacterBoard(props: CharacterBoardProps): JSX.Element {
  const store = useCharacterStore();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(DEFAULT_PAN);
  const [viewMode, setViewMode] = useState<CharacterViewMode>('canvas');
  const [archiveFlow, setArchiveFlow] = useState<ArchiveFlow | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo<CharacterBoardResponse['characters']>(
    () => (store.board ? filterCharacters(store.board.characters, store.filters) : []),
    [store.board, store.filters]
  );
  const positions = useMemo(
    () => (store.board ? autoCharacterLayout(filtered, store.board.layout) : {}),
    [store.board, filtered]
  );
  const dimensionOptions = useMemo(
    () => deriveDimensionOptions(store.board?.characters ?? []),
    [store.board]
  );

  const handleZoom = useCallback((direction: 1 | -1) => {
    setZoom((current) => clampZoom(current + direction * ZOOM_STEP));
  }, []);

  const handleFit = useCallback(() => {
    const bounds = characterLayoutBounds(positions);
    if (!bounds) return;
    const element = viewportRef.current;
    const width = element?.clientWidth || 900;
    const height = element?.clientHeight || 600;
    const padding = 80;
    const nextZoom = clampZoom(Math.min((width - padding) / bounds.width, (height - padding) / bounds.height));
    setZoom(nextZoom);
    setPan({
      x: (width - bounds.width * nextZoom) / 2 - bounds.minX * nextZoom,
      y: (height - bounds.height * nextZoom) / 2 - bounds.minY * nextZoom
    });
  }, [positions]);

  const handleReset = useCallback(() => {
    setZoom(1);
    setPan(DEFAULT_PAN);
  }, []);

  const handleKeyword = useCallback((value: string) => {
    store.setFilters({ ...store.filters, keyword: value });
  }, [store]);

  const handleDimensionChange = useCallback((dim: CharacterFilterDimension, value: string) => {
    const next: CharacterFilters = { ...store.filters };
    if (value === 'all') {
      delete next[dim];
    } else {
      next[dim] = value;
    }
    store.setFilters(next);
  }, [store]);

  const handleMove = useCallback((updates: CharacterPositionUpdate[]) => {
    void store.saveLayout(updates);
  }, [store]);

  const handleOpenCharacter = useCallback((characterId: string) => {
    // T34 仅占位：选中由 store 承担，详情面板留给 T35
    store.selectCharacter(characterId);
    props.onOpenCharacter?.(characterId);
  }, [store, props.onOpenCharacter]);

  // 归档确认（T38）：先归档拿影响摘要与扫描作业，再在弹层展示关系 / 成长事件影响、扫描进度与命中段落
  const handleArchiveRequest = useCallback(async (characterId: string) => {
    const name = store.board?.characters.find((character) => character.id === characterId)?.name ?? '该角色';
    store.setError('');
    try {
      const result = await store.client.archiveCharacter(store.workId, characterId);
      setArchiveFlow({ characterId, name, impact: result.impact, scan: result.scan });
      props.onArchiveRequest?.(characterId);
      await store.reload();
    } catch (cause) {
      store.setError(characterErrorMessage(cause));
    }
  }, [props, store]);

  return (
    <section className="character-workspace" aria-label="角色版图">
      <CharacterToolbar
        view={viewMode}
        onView={setViewMode}
        workId={store.workId}
        client={store.client}
        onImported={() => void store.reload()}
        zoom={zoom}
        onZoomIn={() => handleZoom(1)}
        onZoomOut={() => handleZoom(-1)}
        onFit={handleFit}
        onReset={handleReset}
        keyword={store.filters.keyword ?? ''}
        onKeyword={handleKeyword}
        filters={store.filters}
        dimensionOptions={dimensionOptions}
        onDimensionChange={handleDimensionChange}
        resultCount={filtered.length}
        busy={store.busy}
      />
      {store.loading ? <p className="character-status" role="status">正在加载角色版图…</p> : null}
      {store.error ? <p className="character-error" role="alert">{store.error}</p> : null}
      {store.notice ? <p className="character-notice" role="status">{store.notice}</p> : null}
      <div className="character-viewport" ref={viewportRef}>
        {viewMode === 'archive' ? (
          <CharacterArchiveView
            workId={store.workId}
            client={store.client}
            onSelect={handleOpenCharacter}
            onRestored={() => void store.reload()}
          />
        ) : store.board ? (
          viewMode === 'list' ? (
            <CharacterList
              onOpen={handleOpenCharacter}
              onRequestArchive={(characterId) => void handleArchiveRequest(characterId)}
            />
          ) : (
            <CharacterCanvas
              characters={filtered}
              relations={store.board.relations}
              positions={positions}
              zoom={zoom}
              pan={pan}
              selectedCharacterId={store.selectedCharacterId}
              selectedRelationId={store.selectedRelationId}
              onSelectCharacter={store.selectCharacter}
              onSelectRelation={store.selectRelation}
              onMove={handleMove}
              onZoom={handleZoom}
              onPan={setPan}
            />
          )
        ) : !store.loading ? (
          <p className="character-empty" role="status">还没有角色，新建角色后将出现在版图中。</p>
        ) : null}
      </div>
      {archiveFlow ? (
        <div className="character-archive-dialog" role="dialog" aria-modal="true" aria-label={`归档确认：${archiveFlow.name}`}>
          <div className="character-archive-dialog__head">
            <h3>归档确认：{archiveFlow.name}</h3>
            <button type="button" onClick={() => setArchiveFlow(null)}>关闭归档确认</button>
          </div>
          <dl className="character-archive-impact">
            <div><dt>关系</dt><dd>{archiveFlow.impact.relations} 条</dd></div>
            <div><dt>成长事件</dt><dd>{archiveFlow.impact.growth_events} 条</dd></div>
            <div><dt>涉及章节</dt><dd>{archiveFlow.impact.chapters} 章</dd></div>
            <div><dt>专属剧情节点</dt><dd>{archiveFlow.impact.exclusive_plot_nodes} 个</dd></div>
          </dl>
          <p className="character-archive-scan" role="status">
            扫描{archiveFlow.scan.status === 'succeeded' ? '已完成' : archiveFlow.scan.status === 'failed' ? '失败，可在下方重试' : '进行中'}
            （共 {archiveFlow.scan.total_chapters} 章）
          </p>
          <CharacterAnchorPanel
            workId={store.workId}
            characterId={archiveFlow.characterId}
            client={store.client}
            impact={archiveFlow.impact}
            onDismissed={() => void store.reload()}
            {...(props.chapters ? { chapters: props.chapters, chapterIds: props.chapters.map((chapter) => chapter.id) } : {})}
          />
        </div>
      ) : null}
    </section>
  );
}

interface WorkspaceProps {
  workId: string;
  client?: CharacterClient;
  enabled?: boolean;
  /** 列表 Enter / 画布打开详情：接入右侧角色面板 */
  onOpenCharacter?: ((characterId: string) => void) | undefined;
  /** 归档完成后同步深链到该角色 */
  onArchiveRequest?: ((characterId: string) => void) | undefined;
  /** 章节列表：归档影响说明的命中段落按章节读取（T38） */
  chapters?: { id: string; title: string }[] | undefined;
}

/** 工作台中央「角色版图」页签内容（T32 壳子 → T33 画布 → T34 列表 → T38 归档视图） */
export function CharacterWorkspace({ workId, client, enabled, onOpenCharacter, onArchiveRequest, chapters }: WorkspaceProps): JSX.Element {
  return (
    <CharacterStoreProvider workId={workId} client={client ?? characterClient} enabled={enabled ?? true}>
      <CharacterBoard onOpenCharacter={onOpenCharacter} onArchiveRequest={onArchiveRequest} chapters={chapters} />
    </CharacterStoreProvider>
  );
}
