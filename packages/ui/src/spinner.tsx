export interface SpinnerProps {
  /** 尺寸 */
  size?: 'sm' | 'md' | 'lg';
  /** 附加文案（可选，紧随加载圈） */
  label?: string;
  className?: string;
}

const SIZE_CLASS: Record<NonNullable<SpinnerProps['size']>, string> = {
  sm: 'sf-spinner--sm',
  md: '',
  lg: 'sf-spinner--lg',
};

/**
 * 加载指示器。可选 label 文案。
 */
export function Spinner({ size = 'md', label, className }: SpinnerProps) {
  return (
    <span className={['sf-spinner-wrap', className ?? ''].filter(Boolean).join(' ')}>
      <span className={['sf-spinner', SIZE_CLASS[size]].filter(Boolean).join(' ')} role="status" aria-label={label ?? '加载中'} />
      {label ? <span className="sf-spinner-label">{label}</span> : null}
    </span>
  );
}
