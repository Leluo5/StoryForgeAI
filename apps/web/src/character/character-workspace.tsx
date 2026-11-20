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
  type CharacterFilterDimension
} from './character-toolbar';
import { CharacterCanvas } from './character-canvas';

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

/** 角色版图主视图：工具栏 + 画布，持有缩放与平移本地状态（T33） */
function CharacterBoard(): JSX.Element {
  const store = useCharacterStore();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(DEFAULT_PAN);
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

  return (
    <section className="character-workspace" aria-label="角色版图">
      <CharacterToolbar
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
        {store.board ? (
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
        ) : !store.loading ? (
          <p className="character-empty" role="status">还没有角色，新建角色后将出现在版图中。</p>
        ) : null}
      </div>
    </section>
  );
}

interface WorkspaceProps {
  workId: string;
  client?: CharacterClient;
  enabled?: boolean;
}

/** 工作台中央「角色版图」页签内容（T32 壳子 → T33 真实实现） */
export function CharacterWorkspace({ workId, client, enabled }: WorkspaceProps): JSX.Element {
  return (
    <CharacterStoreProvider workId={workId} client={client ?? characterClient} enabled={enabled ?? true}>
      <CharacterBoard />
    </CharacterStoreProvider>
  );
}
