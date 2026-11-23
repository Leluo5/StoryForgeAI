import type { ReactNode } from 'react';

export interface ToolbarButton {
  key: string;
  label: ReactNode;
  onClick: () => void;
  /** 是否处于激活态 */
  active?: boolean;
  disabled?: boolean;
  /** 附加 title 提示 */
  title?: string;
}

export interface ToolbarProps {
  buttons: ToolbarButton[];
  /** 右侧扩展区（可选） */
  extra?: ReactNode;
  className?: string;
}

/**
 * 工具栏。支持按钮组 + 右侧扩展区。
 */
export function Toolbar({ buttons, extra, className }: ToolbarProps) {
  const classes = ['sf-toolbar', className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={classes} role="toolbar">
      {buttons.map((btn) => (
        <button
          key={btn.key}
          type="button"
          title={btn.title}
          disabled={btn.disabled}
          className={['sf-toolbar__btn', btn.active ? 'sf-toolbar__btn--active' : '']
            .filter(Boolean)
            .join(' ')}
          onClick={btn.onClick}
          aria-pressed={btn.active}
        >
          {btn.label}
        </button>
      ))}
      <span className="sf-toolbar__spacer" />
      {extra}
    </div>
  );
}
