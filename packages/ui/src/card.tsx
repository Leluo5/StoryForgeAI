import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** 是否可交互（悬停提升 + 指针） */
  interactive?: boolean;
  /** 卡片头部（可选，渲染在 body 之上） */
  header?: ReactNode;
  /** 是否渲染 body 内边距 */
  padded?: boolean;
}

/**
 * 卡片容器。支持 header、interactive 悬停、padded 控制内边距。
 */
export function Card({
  interactive = false,
  header,
  padded = true,
  className,
  children,
  ...rest
}: CardProps) {
  const classes = ['sf-card', interactive ? 'sf-card--interactive' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} {...rest}>
      {header ? <div className="sf-card__header">{header}</div> : null}
      {padded ? <div className="sf-card__body">{children}</div> : children}
    </div>
  );
}
