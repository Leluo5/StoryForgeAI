import { useEffect, useId, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import type { ArchivedOwnerNode, PlotGroup, PlotLink, PlotNode } from '@storyforge/contracts';
import { NODE_HEIGHT, NODE_WIDTH, clampPosition, type PositionUpdate } from './plot-layout';
import { ORIGIN_LABEL } from './plot-state';
import {
  ARCHIVED_EDGE_LABEL,
  ARCHIVED_PARENT_HINT,
  archivedNodeIds,
  archivedNodeMap,
  archivedStubPosition
} from './plot-archived';

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

interface Props {
  nodes: PlotNode[];
  links: PlotLink[];
  groups: PlotGroup[];
  /** 被归档过滤隐藏的节点（含 stub 坐标），用于单端连线虚线 */
  archivedNodes?: ArchivedOwnerNode[];
  selectedNodeId: string | null;
  selectedLinkId: string | null;
  highlightIds: Set<string>;
  zoom: number;
  pan: { x: number; y: number };
  onSelectNode: (nodeId: string) => void;
  onSelectLink: (linkId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onMove: (updates: PositionUpdate[]) => void;
  onZoom: (direction: 1 | -1) => void;
}

function center(node: PlotNode): { x: number; y: number } {
  return { x: node.position.x + NODE_WIDTH / 2, y: node.position.y + NODE_HEIGHT / 2 };
}

/** 剧情画布：只负责渲染与拖拽交互，状态由工作区持有 */
export function PlotCanvas(props: Props): JSX.Element {
  const markerId = `plot-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const nodeMap = new Map(props.nodes.map((node) => [node.id, node]));
  const archivedMap = archivedNodeMap(props.archivedNodes ?? []);
  const archivedIds = archivedNodeIds(props.archivedNodes ?? []);

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

  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>, node: PlotNode) {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      originX: node.position.x,
      originY: node.position.y,
      dx: 0,
      dy: 0,
      moved: false
    });
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / props.zoom;
    const dy = (event.clientY - drag.startY) / props.zoom;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      setDrag({ ...drag, dx, dy, moved: true });
    }
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (drag.moved) {
      props.onMove([
        {
          node_id: drag.id,
          x: clampPosition(drag.originX + drag.dx),
          y: clampPosition(drag.originY + drag.dy)
        }
      ]);
    }
    setDrag(null);
  }

  const positioned = (node: PlotNode) =>
    drag && drag.id === node.id
      ? { x: node.position.x + drag.dx, y: node.position.y + drag.dy }
      : node.position;

  return (
    <div
      ref={containerRef}
      className="plot-canvas"
      role="application"
      aria-label="剧情画布，可拖拽节点调整位置"
      tabIndex={0}
    >
      <div
        className="plot-canvas-plane"
        style={{ transform: `translate(${props.pan.x}px, ${props.pan.y}px) scale(${props.zoom})` }}
      >
        <svg className="plot-links" width="1" height="1" aria-hidden="true">
          <defs>
            <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="plot-arrow-head" />
            </marker>
          </defs>
          {props.nodes.map((node) => {
            const parent = node.parent_id ? nodeMap.get(node.parent_id) : undefined;
            const archivedParent = node.parent_id ? archivedMap.get(node.parent_id) : undefined;
            if (!parent && !archivedParent) return null;
            const to = positioned(node);
            const from = parent ? positioned(parent) : archivedStubPosition(archivedParent, to);
            const path = `M ${from.x + NODE_WIDTH / 2} ${from.y + NODE_HEIGHT} C ${from.x + NODE_WIDTH / 2} ${from.y + NODE_HEIGHT + 40}, ${to.x + NODE_WIDTH / 2} ${to.y - 40}, ${to.x + NODE_WIDTH / 2} ${to.y}`;
            const archived = !parent;
            return (
              <path
                key={`p-${node.id}`}
                data-plot-edge={archived ? 'parent-archived' : 'parent'}
                className={`plot-edge ${archived ? 'plot-edge-archived' : 'plot-edge-parent'}`}
                d={path}
              />
            );
          })}
          {props.links.map((link) => {
            const source = nodeMap.get(link.source_id);
            const target = nodeMap.get(link.target_id);
            const sourceArchived = archivedMap.get(link.source_id);
            const targetArchived = archivedMap.get(link.target_id);
            // 两端都隐藏（或引用缺失）不渲染；仅一端隐藏保留虚线 stub
            if (!source && !target) return null;
            const dashed = !source || !target;
            const fromSource = source
              ? center({ ...source, position: positioned(source) })
              : archivedStubPosition(sourceArchived ?? targetArchived, positioned(target!));
            const toTarget = target
              ? center({ ...target, position: positioned(target) })
              : archivedStubPosition(targetArchived ?? sourceArchived, positioned(source!));
            const midX = (fromSource.x + toTarget.x) / 2;
            const midY = (fromSource.y + toTarget.y) / 2;
            if (dashed) {
              const archivedNodeId = source ? link.target_id : link.source_id;
              return (
                <g key={link.id} data-plot-edge="archived" data-link-id={link.id} data-archived-node-id={archivedNodeId}>
                  <path
                    className="plot-edge plot-edge-archived"
                    d={`M ${fromSource.x} ${fromSource.y} L ${toTarget.x} ${toTarget.y}`}
                  />
                  <text className="plot-edge-archive-label" x={midX} y={midY - 6} textAnchor="middle">
                    {ARCHIVED_EDGE_LABEL}
                  </text>
                </g>
              );
            }
            return (
              <path
                key={link.id}
                data-plot-edge={link.type}
                data-link-id={link.id}
                className={`plot-edge plot-edge-${link.type === 'linear' ? 'linear' : 'nonlinear'}${props.selectedLinkId === link.id ? ' is-selected' : ''}`}
                d={`M ${fromSource.x} ${fromSource.y} L ${toTarget.x} ${toTarget.y}`}
                markerEnd={link.type === 'linear' ? `url(#${markerId})` : undefined}
                onClick={() => props.onSelectLink(link.id)}
              />
            );
          })}
        </svg>

        {props.groups.map((group) => {
          const members = props.nodes.filter((node) => node.group_id === group.id);
          if (members.length === 0) return null;
          const xs = members.map((node) => node.position.x);
          const ys = members.map((node) => node.position.y);
          const minX = Math.min(...xs) - 28;
          const minY = Math.min(...ys) - 44;
          const width = Math.max(...xs) + NODE_WIDTH + 28 - minX;
          const height = Math.max(...ys) + NODE_HEIGHT + 28 - minY;
          return (
            <div
              key={group.id}
              className={`plot-group-box plot-group-${group.kind}`}
              data-group-id={group.id}
              style={{ left: minX, top: minY, width, height }}
            >
              <span className="plot-group-label">{group.name}{group.kind === 'swimlane' ? ' · 泳道' : ''}</span>
            </div>
          );
        })}

        {props.nodes.map((node) => {
          const position = positioned(node);
          const isSelected = props.selectedNodeId === node.id;
          const isHighlight = props.highlightIds.has(node.id);
          const archivedParent = node.parent_id !== null && archivedIds.has(node.parent_id);
          return (
            <button
              key={node.id}
              type="button"
              data-node-id={node.id}
              data-origin={node.origin}
              data-archived-parent={archivedParent ? 'true' : undefined}
              className={`plot-node${isSelected ? ' is-selected' : ''}${isHighlight ? ' is-highlight' : ''}${archivedParent ? ' has-archived-parent' : ''}`}
              style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
              aria-pressed={isSelected}
              onPointerDown={(event) => handlePointerDown(event, node)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onClick={() => props.onSelectNode(node.id)}
              onDoubleClick={() => props.onSelectNode(node.id)}
              onKeyDown={(event) => {
                if (event.key === 'Delete' || event.key === 'Backspace') {
                  event.preventDefault();
                  props.onDeleteNode(node.id);
                }
              }}
            >
              <span className="plot-node-title">{node.title}</span>
              {archivedParent ? <span className="plot-node-archived-hint">{ARCHIVED_PARENT_HINT}</span> : null}
              {node.summary ? <span className="plot-node-summary">{node.summary}</span> : null}
              <span className="plot-node-meta">来源 {ORIGIN_LABEL[node.origin]}</span>
            </button>
          );
        })}
      </div>
      {props.nodes.length === 0 ? (
        <p className="plot-canvas-empty">还没有节点，点击「新增节点」开始搭建剧情结构。</p>
      ) : null}
    </div>
  );
}
