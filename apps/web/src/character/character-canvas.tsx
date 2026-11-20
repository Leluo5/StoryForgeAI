import { memo, useEffect, useId, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import type { CharacterBoardResponse, CharacterRelation } from '@storyforge/contracts';
import { CHARACTER_CARD_HEIGHT, CHARACTER_CARD_WIDTH, clampCharacterPosition } from './character-layout';
import type { CharacterPoint, CharacterPositionUpdate } from './character-state';

interface DragState {
  id: string;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  dx: number;
  dy: number;
  moved: boolean;
}

interface PanState {
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

interface Props {
  characters: CharacterBoardResponse['characters'];
  relations: CharacterRelation[];
  positions: Record<string, CharacterPoint>;
  zoom: number;
  pan: { x: number; y: number };
  selectedCharacterId: string | null;
  selectedRelationId: string | null;
  onSelectCharacter: (characterId: string) => void;
  onSelectRelation: (relationId: string) => void;
  onMove: (updates: CharacterPositionUpdate[]) => void;
  onZoom: (direction: 1 | -1) => void;
  onPan: (pan: { x: number; y: number }) => void;
}

const DIMENSION_KEYS = ['country_region', 'faith', 'faction', 'race', 'occupation', 'age_band'] as const;

function dashArrayFor(lineStyle: string): string | undefined {
  if (lineStyle === 'dashed') return '8 6';
  if (lineStyle === 'dotted') return '2 4';
  return undefined;
}

function center(point: CharacterPoint): { x: number; y: number } {
  return { x: point.x + CHARACTER_CARD_WIDTH / 2, y: point.y + CHARACTER_CARD_HEIGHT / 2 };
}

interface CardProps {
  character: CharacterBoardResponse['characters'][number];
  position: CharacterPoint;
  selected: boolean;
  dragging: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onClick: () => void;
}

const CharacterCard = memo(function CharacterCard({ character, position, selected, dragging, onPointerDown, onPointerMove, onPointerUp, onClick }: CardProps): JSX.Element {
  const dims = DIMENSION_KEYS
    .map((key) => character.six_dim[key])
    .filter((value): value is string => value != null && value !== '');
  const meta = character.status === 'archived' ? '已归档' : character.six_dim.occupation ?? character.six_dim.age_band ?? '';
  // 可访问名必须包含全部可见文字（WCAG 2.5.3），否则 label-content-name-mismatch
  const accessibleName = [
    character.name,
    meta,
    ...dims.slice(0, 3),
    character.status === 'archived' ? '已归档' : ''
  ].filter((value) => value !== '').join('，');
  return (
    <button
      type="button"
      data-character-id={character.id}
      data-character-status={character.status}
      className={`character-card${selected ? ' is-selected' : ''}${dragging ? ' is-dragging' : ''}${character.status === 'archived' ? ' is-archived' : ''}`}
      style={{ left: position.x, top: position.y, width: CHARACTER_CARD_WIDTH, height: CHARACTER_CARD_HEIGHT }}
      aria-pressed={selected}
      aria-label={accessibleName}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={onClick}
    >
      <span className="character-card__name">{character.name}</span>
      {meta ? <span className="character-card__meta">{meta}</span> : null}
      {dims.length > 0 ? (
        <span className="character-card__tags">
          {dims.slice(0, 3).map((value) => (
            <span key={value} className="character-card__tag">{value}</span>
          ))}
        </span>
      ) : null}
    </button>
  );
});

/** 角色版图画布：绝对定位卡片 + SVG 连线 + 平移缩放 + 拖拽批量提交（T33） */
export function CharacterCanvas(props: Props): JSX.Element {
  const markerId = `character-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [pan, setPan] = useState<PanState | null>(null);
  const visibleIds = useMemo(() => new Set(props.characters.map((character) => character.id)), [props.characters]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const handle = (event: WheelEvent) => {
      event.preventDefault();
      props.onZoom(event.deltaY > 0 ? -1 : 1);
    };
    element.addEventListener('wheel', handle, { passive: false });
    return () => element.removeEventListener('wheel', handle);
  }, [props.onZoom]);

  function positioned(characterId: string): CharacterPoint | null {
    const base = props.positions[characterId];
    if (!base) return null;
    if (drag && drag.id === characterId) {
      return { x: base.x + drag.dx, y: base.y + drag.dy };
    }
    return base;
  }

  function handleCardPointerDown(event: ReactPointerEvent<HTMLButtonElement>, characterId: string) {
    // 卡片拖拽不触发背景平移
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* jsdom/旧浏览器忽略 */ }
    const base = props.positions[characterId];
    if (!base) return;
    setDrag({
      id: characterId,
      startX: event.clientX,
      startY: event.clientY,
      originX: base.x,
      originY: base.y,
      dx: 0,
      dy: 0,
      moved: false
    });
  }

  function handleCardPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / props.zoom;
    const dy = (event.clientY - drag.startY) / props.zoom;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      setDrag({ ...drag, dx, dy, moved: true });
    }
  }

  function handleCardPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag) return;
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* jsdom/旧浏览器忽略 */ }
    if (drag.moved) {
      props.onMove([
        {
          character_id: drag.id,
          x: clampCharacterPosition(drag.originX + drag.dx),
          y: clampCharacterPosition(drag.originY + drag.dy)
        }
      ]);
    }
    setDrag(null);
  }

  function handleBackgroundPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    try { containerRef.current?.setPointerCapture?.(event.pointerId); } catch { /* jsdom/旧浏览器忽略 */ }
    setPan({ startX: event.clientX, startY: event.clientY, originX: props.pan.x, originY: props.pan.y });
  }

  function handleBackgroundPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pan) return;
    props.onPan({ x: pan.originX + (event.clientX - pan.startX), y: pan.originY + (event.clientY - pan.startY) });
  }

  function handleBackgroundPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pan) return;
    containerRef.current?.releasePointerCapture?.(event.pointerId);
    setPan(null);
  }

  return (
    <div
      ref={containerRef}
      className="character-canvas"
      role="application"
      aria-label="角色版图画布，可拖拽角色卡调整位置"
      tabIndex={0}
      onPointerDown={handleBackgroundPointerDown}
      onPointerMove={handleBackgroundPointerMove}
      onPointerUp={handleBackgroundPointerUp}
    >
      <div
        className="character-canvas-plane"
        style={{ transform: `translate(${props.pan.x}px, ${props.pan.y}px) scale(${props.zoom})` }}
      >
        <svg className="character-links" width="1" height="1" aria-hidden="true">
          <defs>
            <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>
          {props.relations.map((relation) => {
            if (!visibleIds.has(relation.source_id) || !visibleIds.has(relation.target_id)) return null;
            const from = positioned(relation.source_id);
            const to = positioned(relation.target_id);
            if (!from || !to) return null;
            const a = center(from);
            const b = center(to);
            const midX = (a.x + b.x) / 2;
            const midY = (a.y + b.y) / 2;
            const tag = relation.tag;
            const chipWidth = Math.max(28, tag.length * 7 + 12);
            const isSelected = props.selectedRelationId === relation.id;
            return (
              <g key={relation.id} data-character-relation={relation.id} data-relation-directed={relation.directed}>
                <path
                  d={`M ${a.x} ${a.y} L ${b.x} ${b.y}`}
                  className={`character-edge${isSelected ? ' is-selected' : ''}`}
                  stroke={relation.color}
                  strokeDasharray={dashArrayFor(relation.line_style)}
                  markerEnd={relation.directed ? `url(#${markerId})` : undefined}
                  onClick={() => props.onSelectRelation(relation.id)}
                />
                <g className="character-edge-label" transform={`translate(${midX}, ${midY})`} onClick={() => props.onSelectRelation(relation.id)}>
                  <rect x={-chipWidth / 2} y={-9} width={chipWidth} height={18} rx={4} />
                  <text x={0} y={4} textAnchor="middle">{tag}</text>
                </g>
              </g>
            );
          })}
        </svg>

        {props.characters.map((character) => {
          const position = positioned(character.id);
          if (!position) return null;
          return (
            <CharacterCard
              key={character.id}
              character={character}
              position={position}
              selected={props.selectedCharacterId === character.id}
              dragging={drag?.id === character.id}
              onPointerDown={(event) => handleCardPointerDown(event, character.id)}
              onPointerMove={handleCardPointerMove}
              onPointerUp={handleCardPointerUp}
              onClick={() => props.onSelectCharacter(character.id)}
            />
          );
        })}
      </div>
      {props.characters.length === 0 ? (
        <p className="character-canvas-empty">没有匹配的角色，调整筛选条件后再试。</p>
      ) : null}
    </div>
  );
}
