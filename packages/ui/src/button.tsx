import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 视觉变体 */
  variant?: ButtonVariant;
  /** 紧凑尺寸 */
  size?: 'md' | 'sm';
  /** 占满父容器宽度 */
  block?: boolean;
  /** 加载态：显示 spinner 并禁用 */
  loading?: boolean;
  /** 图标（置于文字前） */
  icon?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'sf-btn--primary',
  secondary: 'sf-btn--secondary',
  danger: 'sf-btn--danger',
  ghost: 'sf-btn--ghost',
};

/**
 * 通用按钮。变体：primary / secondary / danger / ghost。
 * 尺寸：md（默认）/ sm。支持 loading、block、icon。
 */
export function Button({
  variant = 'primary',
  size = 'md',
  block = false,
  loading = false,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const classes = [
    'sf-btn',
    VARIANT_CLASS[variant],
    size === 'sm' ? 'sf-btn--sm' : '',
    block ? 'sf-btn--block' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="sf-spinner sf-spinner--sm" aria-hidden="true" /> : null}
      {!loading && icon ? <span aria-hidden="true">{icon}</span> : null}
      {children}
    </button>
  );
}
