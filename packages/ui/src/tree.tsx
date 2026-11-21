import type { ReactNode } from 'react';

export interface TreeNode {
  key: string;
  label: ReactNode;
  /** 子节点（可选） */
  children?: TreeNode[];
  /** 是否默认展开 */
  defaultExpanded?: boolean;
  /** 附加元信息（如章节字数） */
  meta?: ReactNode;
  disabled?: boolean;
}

export interface TreeProps {
  nodes: TreeNode[];
  /** 当前选中节点 key */
  selectedKey?: string;
  onSelect?: (key: string) => void;
  /** 受控展开集合（可选，未提供时内部管理） */
  expandedKeys?: string[];
  onToggle?: (key: string) => void;
  className?: string;
}

/**
 * 树形导航。受控/非受控展开，支持选中高亮与 meta 信息。
 */
export function Tree({
  nodes,
  selectedKey,
  onSelect,
  expandedKeys,
  onToggle,
  className,
}: TreeProps) {
  const classes = ['sf-tree', className ?? ''].filter(Boolean).join(' ');
  return (
    <ul className={classes} role="tree">
      {nodes.map((node) => (
        <TreeNodeItem
          key={node.key}
          node={node}
          depth={0}
          selectedKey={selectedKey}
          onSelect={onSelect}
          expandedKeys={expandedKeys}
          onToggle={onToggle}
        />
      ))}
    </ul>
  );
}

function TreeNodeItem({
  node,
  depth,
  selectedKey,
  onSelect,
  expandedKeys,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  selectedKey?: string | undefined;
  onSelect?: ((key: string) => void) | undefined;
  expandedKeys?: string[] | undefined;
  onToggle?: ((key: string) => void) | undefined;
}) {
  const hasChildren = !!node.children?.length;
  const isExpanded = expandedKeys ? expandedKeys.includes(node.key) : !!node.defaultExpanded;
  const isActive = selectedKey === node.key;

  return (
    <li className="sf-tree__node" role="treeitem" aria-selected={isActive} aria-expanded={hasChildren ? isExpanded : undefined}>
      <div
        className={['sf-tree__row', isActive ? 'sf-tree__row--active' : ''].filter(Boolean).join(' ')}
        style={depth > 0 ? { paddingLeft: 8 + depth * 16 } : undefined}
        onClick={() => onSelect?.(node.key)}
      >
        {hasChildren ? (
          <button
            type="button"
            className="sf-tree__caret"
            aria-label={isExpanded ? '折叠' : '展开'}
            onClick={(e) => {
              e.stopPropagation();
              onToggle?.(node.key);
            }}
          >
            {isExpanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="sf-tree__caret" aria-hidden="true" />
        )}
        <span className="sf-tree__label">{node.label}</span>
        {node.meta ? <span className="sf-tree__meta">{node.meta}</span> : null}
      </div>
      {hasChildren && isExpanded ? (
        <ul className="sf-tree__children" role="group">
          {node.children!.map((child) => (
            <TreeNodeItem
              key={child.key}
              node={child}
              depth={depth + 1}
              selectedKey={selectedKey}
              onSelect={onSelect}
              expandedKeys={expandedKeys}
              onToggle={onToggle}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
