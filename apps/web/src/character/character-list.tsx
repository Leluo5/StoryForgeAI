import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react';
import type { CharacterBoardResponse, CharacterRelation } from '@storyforge/contracts';
import { filterCharacters, useCharacterStore } from './character-state';
import './character-list.css';

type BoardCharacter = CharacterBoardResponse['characters'][number];

export interface CharacterListProps {
  /** Enter / 双击打开角色详情（主控接入右侧角色面板） */
  onOpen?: (characterId: string) => void;
  /** Delete 确认后请求归档该角色（主控接入归档流程） */
  onRequestArchive?: (characterId: string) => void;
}

/** 窄屏阈值：<768px 折叠为列表 + 抽屉（375 命中；768 / 1024 / 1440 为宽屏） */
export const COMPACT_MAX_WIDTH = 767;

/** 纯函数：视口宽度是否走紧凑布局（便于在 jsdom 中直接单测四档边界） */
export function isCompactViewport(width: number): boolean {
  return width <= COMPACT_MAX_WIDTH;
}

const CHARACTER_COLUMNS = 3;
const RELATION_COLUMNS = 4;

const LINE_STYLE_LABELS: Record<CharacterRelation['line_style'], string> = {
  solid: '实线',
  dashed: '虚线',
  dotted: '点线'
};

/** 角色行占 3 列，关系行占 4 列：roving tabindex 需要按行类型换算列数 */
function columnCount(row: number, characterCount: number): number {
  return row < characterCount ? CHARACTER_COLUMNS : RELATION_COLUMNS;
}

function statusLabel(status: BoardCharacter['status']): string {
  if (status === 'archived') return '已归档';
  if (status === 'merged') return '已合并';
  return '使用中';
}

function sixDimSummary(character: BoardCharacter): string {
  return [
    character.six_dim.country_region,
    character.six_dim.faction,
    character.six_dim.race,
    character.six_dim.occupation,
    character.six_dim.age_band,
    character.six_dim.faith
  ]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' · ');
}

/** 方向不只用箭头/颜色表达：文字给出「有向/无向 + 实线/虚线/点线」 */
function directionLabel(relation: CharacterRelation): string {
  return `${relation.directed ? '有向' : '无向'} · ${LINE_STYLE_LABELS[relation.line_style]}`;
}

function readCompactViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return isCompactViewport(window.innerWidth);
}

/** 订阅视口宽度：仅监听 resize / matchMedia，不注册任何全局键盘快捷键 */
function useCompactViewport(): boolean {
  const [compact, setCompact] = useState(readCompactViewport);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sync = (): void => setCompact(readCompactViewport());
    sync();
    window.addEventListener('resize', sync);
    const query = typeof window.matchMedia === 'function'
      ? window.matchMedia(`(max-width: ${COMPACT_MAX_WIDTH}px)`)
      : null;
    query?.addEventListener?.('change', sync);
    return () => {
      window.removeEventListener('resize', sync);
      query?.removeEventListener?.('change', sync);
    };
  }, []);

  return compact;
}

interface PendingArchive {
  id: string;
  name: string;
}

type CellKind = 'character' | 'relation';

interface SummaryProps {
  character: BoardCharacter;
  relationCount: number;
  onOpen: () => void;
}

/** 角色摘要（抽屉与宽屏侧栏共用；不含 T35 的编辑表单） */
function CharacterSummary({ character, relationCount, onOpen }: SummaryProps): JSX.Element {
  const summary = sixDimSummary(character);
  return (
    <div className="character-list-summary">
      <h3 className="character-list-detail-title">{character.name}</h3>
      <p className="character-list-detail-meta">
        {statusLabel(character.status)}
        {summary ? ` · ${summary}` : ''}
      </p>
      <p className="character-list-detail-meta">{relationCount} 条可见关系</p>
      <button type="button" className="character-list-detail-open" onClick={onOpen}>打开详情</button>
    </div>
  );
}

/** 角色版图的无障碍等价列表：角色表 + 关系表 + 键盘导航 + 窄屏抽屉（T34） */
export function CharacterList({ onOpen, onRequestArchive }: CharacterListProps): JSX.Element {
  const store = useCharacterStore();
  const compact = useCompactViewport();
  const uniqueId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const confirmTextId = `character-list-confirm-text-${uniqueId}`;
  const confirmTitleId = `character-list-confirm-title-${uniqueId}`;

  const cellRefs = useRef(new Map<string, HTMLSpanElement>());
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);

  const [active, setActive] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  const [pendingArchive, setPendingArchive] = useState<PendingArchive | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 与画布共享同一份筛选状态：只读 store.filters，不另建筛选状态
  const characters = useMemo(
    () => (store.board ? filterCharacters(store.board.characters, store.filters) : []),
    [store.board, store.filters]
  );
  const visibleIds = useMemo(() => new Set(characters.map((character) => character.id)), [characters]);
  // 关系表只展示两端角色都在筛选结果内的关系
  const relations = useMemo(
    () => (store.board
      ? store.board.relations.filter(
        (relation) => visibleIds.has(relation.source_id) && visibleIds.has(relation.target_id)
      )
      : []),
    [store.board, visibleIds]
  );
  const nameById = useMemo(
    () => new Map((store.board?.characters ?? []).map((character) => [character.id, character.name] as const)),
    [store.board]
  );
  const relationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const relation of relations) {
      counts.set(relation.source_id, (counts.get(relation.source_id) ?? 0) + 1);
      counts.set(relation.target_id, (counts.get(relation.target_id) ?? 0) + 1);
    }
    return counts;
  }, [relations]);

  const totalRows = characters.length + relations.length;
  const activeCell = useMemo(() => {
    if (totalRows === 0) return null;
    const row = Math.min(active.row, totalRows - 1);
    const col = Math.min(active.col, columnCount(row, characters.length) - 1);
    return { row, col };
  }, [active, totalRows, characters.length]);

  const selectedCharacter = characters.find((character) => character.id === store.selectedCharacterId) ?? null;

  useEffect(() => {
    if (pendingArchive) confirmCancelRef.current?.focus();
  }, [pendingArchive]);

  useEffect(() => {
    if (drawerOpen && compact) drawerCloseRef.current?.focus();
  }, [drawerOpen, compact]);

  const isActiveCell = (row: number, col: number): boolean =>
    activeCell !== null && activeCell.row === row && activeCell.col === col;

  const cellRef = (row: number, col: number) => (element: HTMLSpanElement | null): void => {
    const key = `${row}:${col}`;
    if (element) cellRefs.current.set(key, element);
    else cellRefs.current.delete(key);
  };

  const moveFocus = (row: number, col: number): void => {
    setActive({ row, col });
    cellRefs.current.get(`${row}:${col}`)?.focus();
  };

  const closeConfirm = useCallback((): void => {
    setPendingArchive(null);
    if (activeCell) cellRefs.current.get(`${activeCell.row}:${activeCell.col}`)?.focus();
  }, [activeCell]);

  const confirmArchive = (): void => {
    if (!pendingArchive) return;
    const targetId = pendingArchive.id;
    setPendingArchive(null);
    onRequestArchive?.(targetId);
  };

  const openCharacter = (characterId: string): void => {
    store.selectCharacter(characterId);
    onOpen?.(characterId);
  };

  const handleRowClick = (characterId: string): void => {
    store.selectCharacter(characterId);
    if (compact) setDrawerOpen(true);
  };

  const closeDrawer = (): void => {
    setDrawerOpen(false);
    if (activeCell) cellRefs.current.get(`${activeCell.row}:${activeCell.col}`)?.focus();
  };

  const handleCellKeyDown = (
    event: ReactKeyboardEvent<HTMLSpanElement>,
    row: number,
    col: number,
    characterId: string | null,
    kind: CellKind
  ): void => {
    const lastRow = totalRows - 1;
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const nextRow = Math.min(row + 1, lastRow);
        moveFocus(nextRow, Math.min(col, columnCount(nextRow, characters.length) - 1));
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const nextRow = Math.max(row - 1, 0);
        moveFocus(nextRow, Math.min(col, columnCount(nextRow, characters.length) - 1));
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        const nextCol = Math.min(col + 1, columnCount(row, characters.length) - 1);
        if (nextCol !== col) moveFocus(row, nextCol);
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        const nextCol = Math.max(col - 1, 0);
        if (nextCol !== col) moveFocus(row, nextCol);
        break;
      }
      case 'Home': {
        event.preventDefault();
        moveFocus(row, 0);
        break;
      }
      case 'End': {
        event.preventDefault();
        moveFocus(row, columnCount(row, characters.length) - 1);
        break;
      }
      case 'Enter': {
        event.preventDefault();
        if (characterId) openCharacter(characterId);
        break;
      }
      case 'Delete': {
        // 只对角色行生效；关系行不提供归档入口
        if (kind !== 'character' || !characterId) break;
        event.preventDefault();
        setPendingArchive({ id: characterId, name: nameById.get(characterId) ?? '该角色' });
        break;
      }
      default:
        break;
    }
  };

  if (!store.board) {
    return (
      <div className="character-list-panel">
        <p className="character-list-empty" role="status">
          {store.loading ? '正在加载角色版图…' : '还没有角色，新建角色后将出现在列表中。'}
        </p>
      </div>
    );
  }

  if (characters.length === 0) {
    return (
      <div className="character-list-panel">
        <p className="character-list-empty" role="status">没有匹配的角色，请调整筛选条件后重试。</p>
      </div>
    );
  }

  return (
    <div className="character-list-panel">
      <div className="character-list-main">
        <div className="character-list-scroll">
          <section className="character-list-section" aria-label="角色表格">
            <h3 className="character-list-section-title">角色（{characters.length}）</h3>
            <div
              role="grid"
              aria-label="角色列表"
              aria-colcount={CHARACTER_COLUMNS}
              aria-rowcount={characters.length + 1}
              className="character-list-grid"
            >
              <div role="rowgroup">
                <div role="row" className="character-list-row character-list-row--head">
                  <span role="columnheader" className="character-list-cell">姓名</span>
                  <span role="columnheader" className="character-list-cell">六维摘要</span>
                  <span role="columnheader" className="character-list-cell">关系</span>
                </div>
              </div>
              <div role="rowgroup">
                {characters.map((character, index) => {
                  const selected = store.selectedCharacterId === character.id;
                  return (
                    <div
                      key={character.id}
                      role="row"
                      aria-selected={selected}
                      data-character-id={character.id}
                      data-character-status={character.status}
                      className={`character-list-row${selected ? ' is-selected' : ''}${character.status === 'archived' ? ' is-archived' : ''}`}
                      onClick={() => handleRowClick(character.id)}
                      onDoubleClick={() => openCharacter(character.id)}
                    >
                      <span
                        role="gridcell"
                        aria-selected={selected}
                        tabIndex={isActiveCell(index, 0) ? 0 : -1}
                        ref={cellRef(index, 0)}
                        className="character-list-cell character-list-name"
                        onFocus={() => setActive({ row: index, col: 0 })}
                        onKeyDown={(event) => handleCellKeyDown(event, index, 0, character.id, 'character')}
                      >
                        <span className="character-list-name-text">{character.name}</span>
                        <span className="character-list-status">{statusLabel(character.status)}</span>
                      </span>
                      <span
                        role="gridcell"
                        tabIndex={isActiveCell(index, 1) ? 0 : -1}
                        ref={cellRef(index, 1)}
                        className="character-list-cell character-list-meta"
                        onFocus={() => setActive({ row: index, col: 1 })}
                        onKeyDown={(event) => handleCellKeyDown(event, index, 1, character.id, 'character')}
                      >
                        {sixDimSummary(character) || '未填写六维'}
                      </span>
                      <span
                        role="gridcell"
                        tabIndex={isActiveCell(index, 2) ? 0 : -1}
                        ref={cellRef(index, 2)}
                        className="character-list-cell character-list-count"
                        onFocus={() => setActive({ row: index, col: 2 })}
                        onKeyDown={(event) => handleCellKeyDown(event, index, 2, character.id, 'character')}
                      >
                        {relationCounts.get(character.id) ?? 0} 条关系
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="character-list-section" aria-label="关系表格">
            <h3 className="character-list-section-title">关系（{relations.length}）</h3>
            {relations.length === 0 ? (
              <p className="character-list-detail-empty">当前筛选下没有两端都可见的关系。</p>
            ) : (
              <div
                role="grid"
                aria-label="关系列表"
                aria-colcount={RELATION_COLUMNS}
                aria-rowcount={relations.length + 1}
                className="character-list-grid"
              >
                <div role="rowgroup">
                  <div role="row" className="character-relation-row character-list-row--head">
                    <span role="columnheader" className="character-list-cell">源角色</span>
                    <span role="columnheader" className="character-list-cell">关系</span>
                    <span role="columnheader" className="character-list-cell">方向</span>
                    <span role="columnheader" className="character-list-cell">目标角色</span>
                  </div>
                </div>
                <div role="rowgroup">
                  {relations.map((relation, offset) => {
                    const index = characters.length + offset;
                    const sourceName = nameById.get(relation.source_id) ?? '未知角色';
                    const targetName = nameById.get(relation.target_id) ?? '未知角色';
                    return (
                      <div
                        key={relation.id}
                        role="row"
                        data-relation-id={relation.id}
                        data-relation-directed={relation.directed}
                        className="character-relation-row"
                      >
                        <span
                          role="gridcell"
                          tabIndex={isActiveCell(index, 0) ? 0 : -1}
                          ref={cellRef(index, 0)}
                          className="character-list-cell character-relation-source"
                          onFocus={() => setActive({ row: index, col: 0 })}
                          onKeyDown={(event) => handleCellKeyDown(event, index, 0, relation.source_id, 'relation')}
                        >
                          {sourceName}
                        </span>
                        <span
                          role="gridcell"
                          tabIndex={isActiveCell(index, 1) ? 0 : -1}
                          ref={cellRef(index, 1)}
                          className="character-list-cell character-relation-label"
                          onFocus={() => setActive({ row: index, col: 1 })}
                          onKeyDown={(event) => handleCellKeyDown(event, index, 1, relation.source_id, 'relation')}
                        >
                          <span className="character-relation-tag">{relation.tag}</span>
                          {relation.label !== relation.tag ? (
                            <span className="character-relation-label-text">{relation.label}</span>
                          ) : null}
                        </span>
                        <span
                          role="gridcell"
                          tabIndex={isActiveCell(index, 2) ? 0 : -1}
                          ref={cellRef(index, 2)}
                          className="character-list-cell character-relation-direction"
                          onFocus={() => setActive({ row: index, col: 2 })}
                          onKeyDown={(event) => handleCellKeyDown(event, index, 2, relation.source_id, 'relation')}
                        >
                          {directionLabel(relation)}
                        </span>
                        <span
                          role="gridcell"
                          tabIndex={isActiveCell(index, 3) ? 0 : -1}
                          ref={cellRef(index, 3)}
                          className="character-list-cell character-relation-target"
                          onFocus={() => setActive({ row: index, col: 3 })}
                          onKeyDown={(event) => handleCellKeyDown(event, index, 3, relation.source_id, 'relation')}
                        >
                          {targetName}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      {compact ? (
        drawerOpen && selectedCharacter ? (
          <div
            className="character-list-drawer"
            role="dialog"
            aria-label="角色摘要"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              closeDrawer();
            }}
          >
            <div className="character-list-drawer-head">
              <h3 className="character-list-section-title">角色摘要</h3>
              <button
                ref={drawerCloseRef}
                type="button"
                className="character-list-drawer-close"
                onClick={closeDrawer}
              >
                关闭
              </button>
            </div>
            <CharacterSummary
              character={selectedCharacter}
              relationCount={relationCounts.get(selectedCharacter.id) ?? 0}
              onOpen={() => openCharacter(selectedCharacter.id)}
            />
          </div>
        ) : null
      ) : (
        <aside className="character-list-detail" aria-label="角色摘要">
          {selectedCharacter ? (
            <CharacterSummary
              character={selectedCharacter}
              relationCount={relationCounts.get(selectedCharacter.id) ?? 0}
              onOpen={() => openCharacter(selectedCharacter.id)}
            />
          ) : (
            <p className="character-list-detail-empty">选择一名角色查看摘要。</p>
          )}
        </aside>
      )}

      {pendingArchive ? (
        <div className="character-list-confirm">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={confirmTitleId}
            aria-describedby={confirmTextId}
            className="character-list-confirm-card"
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              closeConfirm();
            }}
          >
            <p id={confirmTitleId} className="character-list-confirm-title">
              确认归档「{pendingArchive.name}」？
            </p>
            <p id={confirmTextId} className="character-list-confirm-text">
              归档后该角色会从当前筛选结果中移除，关系与成长线保留，可在归档区恢复。
            </p>
            <div className="character-list-confirm-actions">
              <button ref={confirmCancelRef} type="button" onClick={closeConfirm}>取消</button>
              <button type="button" className="is-danger" onClick={confirmArchive}>确认归档</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
