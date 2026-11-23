import type { ReactNode } from 'react';

export type BadgeVariant = 'default' | 'brand' | 'success' | 'warning' | 'danger' | 'accent';

export interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
  /** 附加 title 提示（可选） */
  title?: string;
}

const VARIANT_CLASS: Record<BadgeVariant, string> = {
  default: 'sf-badge--default',
  brand: 'sf-badge--brand',
  success: 'sf-badge--success',
  warning: 'sf-badge--warning',
  danger: 'sf-badge--danger',
  accent: 'sf-badge--accent',
};

/**
 * 状态徽标。变体：default / brand / success / warning / danger / accent。
 */
export function Badge({ variant = 'default', children, className, title }: BadgeProps) {
  const classes = ['sf-badge', VARIANT_CLASS[variant], className ?? ''].filter(Boolean).join(' ');
  return (
    <span className={classes} title={title}>
      {children}
    </span>
  );
}
