import { useEffect, useRef, type JSX, type KeyboardEvent } from 'react';
import type { PlotNode } from '@storyforge/contracts';
import { buildTreeRows, ORIGIN_LABEL } from './plot-state';

interface Props {
  nodes: PlotNode[];
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
}

/** 列表视图：画布的等价键盘操作路径（02-技术方案 §6.4） */
export function PlotNodeList(props: Props): JSX.Element {
  const rows = buildTreeRows(props.nodes);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (props.selectedNodeId) itemRefs.current.get(props.selectedNodeId)?.focus();
  }, [props.selectedNodeId]);

  function moveSelection(index: number, delta: number) {
    const next = rows[index + delta];
    if (next) props.onSelect(next.node.id);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>, index: number, node: PlotNode) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveSelection(index, 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveSelection(index, -1);
        break;
      case 'Home':
        event.preventDefault();
        if (rows[0]) props.onSelect(rows[0].node.id);
        break;
      case 'End':
        event.preventDefault();
        if (rows.at(-1)) props.onSelect(rows.at(-1)!.node.id);
        break;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        props.onDelete(node.id);
        break;
      default:
        break;
    }
  }

  if (rows.length === 0) {
    return <p className="plot-list-empty" role="status">没有匹配的节点，试试放宽搜索或筛选条件。</p>;
  }

  return (
    <div className="plot-node-list" role="tree" aria-label="剧情节点列表">
      {rows.map(({ node, depth }, index) => {
        const selected = node.id === props.selectedNodeId;
        return (
          <div
            key={node.id}
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-node-id={node.id}
            ref={(element) => {
              if (element) itemRefs.current.set(node.id, element);
              else itemRefs.current.delete(node.id);
            }}
            className={`plot-list-row${selected ? ' is-selected' : ''}`}
            style={{ paddingLeft: 12 + depth * 20 }}
            onClick={() => props.onSelect(node.id)}
            onKeyDown={(event) => handleKeyDown(event, index, node)}
          >
            <span className="plot-list-title">{node.title}</span>
            <span className="plot-list-meta">
              {ORIGIN_LABEL[node.origin]}
              {node.attributes.place ? ` · ${node.attributes.place}` : ''}
            </span>
            <button
              type="button"
              className="plot-list-delete"
              aria-label={`删除节点 ${node.title}`}
              onClick={(event) => {
                event.stopPropagation();
                props.onDelete(node.id);
              }}
            >
              删除
            </button>
          </div>
        );
      })}
    </div>
  );
}
