import type { ReactNode } from 'react';

export interface TabItem {
  key: string;
  label: ReactNode;
  /** 禁用该页签 */
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  activeKey: string;
  onChange: (key: string) => void;
  /** 页签下方内容面板 */
  children?: ReactNode;
  /** 外层容器 className */
  className?: string;
  /** tablist 的无障碍名称（aria-label） */
  label?: string;
}

/**
 * 页签容器。受控组件：activeKey + onChange。
 */
export function Tabs({ items, activeKey, onChange, children, className, label }: TabsProps) {
  const classes = ['sf-tabs', className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      <div className="sf-tabs__list" role="tablist" aria-label={label}>
        {items.map((item) => {
          const active = item.key === activeKey;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={item.disabled}
              className={['sf-tabs__tab', active ? 'sf-tabs__tab--active' : '']
                .filter(Boolean)
                .join(' ')}
              onClick={() => onChange(item.key)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div className="sf-tabs__panel" role="tabpanel">
        {children}
      </div>
    </div>
  );
}
