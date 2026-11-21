import { useId } from 'react';
import type { TextareaHTMLAttributes } from 'react';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** 字段标签（可选） */
  label?: string;
  /** 校验错误文案 */
  error?: string;
  /** 包裹字段的 className */
  wrapperClassName?: string;
}

/**
 * 多行文本域。可选 label 与 error。
 */
export function Textarea({
  label,
  error,
  wrapperClassName,
  className,
  id,
  ...rest
}: TextareaProps) {
  const autoId = useId();
  const textareaId = id ?? autoId;
  const classes = ['sf-textarea', className ?? ''].filter(Boolean).join(' ');

  return (
    <div className={['sf-field', wrapperClassName ?? ''].filter(Boolean).join(' ')}>
      {label ? (
        <label className="sf-field__label" htmlFor={textareaId}>
          {label}
        </label>
      ) : null}
      <textarea id={textareaId} className={classes} aria-invalid={error ? true : undefined} {...rest} />
      {error ? (
        <span className="sf-field__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
