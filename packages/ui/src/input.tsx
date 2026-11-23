import { useId } from 'react';
import type { InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** 字段标签（可选） */
  label?: string;
  /** 校验错误文案（显示在输入框下方） */
  error?: string;
  /** 包裹字段的 className（用于布局） */
  wrapperClassName?: string;
}

/**
 * 文本输入框。可选 label 与 error，自动关联 aria。
 */
export function Input({
  label,
  error,
  wrapperClassName,
  className,
  id,
  ...rest
}: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const classes = ['sf-input', className ?? ''].filter(Boolean).join(' ');

  return (
    <div className={['sf-field', wrapperClassName ?? ''].filter(Boolean).join(' ')}>
      {label ? (
        <label className="sf-field__label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <input id={inputId} className={classes} aria-invalid={error ? true : undefined} {...rest} />
      {error ? (
        <span className="sf-field__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
