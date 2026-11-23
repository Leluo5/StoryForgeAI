import { useEffect } from 'react';
import type { ReactNode } from 'react';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** 底部操作区（可选） */
  footer?: ReactNode;
  /** 是否显示右上角关闭按钮，默认 true */
  closable?: boolean;
  /** 是否允许点击遮罩关闭，默认 true */
  maskClosable?: boolean;
}

/**
 * 弹窗。支持 footer、closable、maskClosable。Esc 关闭，点击遮罩关闭。
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  closable = true,
  maskClosable = true,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="sf-modal-overlay"
      onClick={maskClosable ? onClose : undefined}
      role="presentation"
    >
      <div
        className="sf-modal"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sf-modal__header">
          <h3 className="sf-modal__title">{title}</h3>
          {closable ? (
            <button type="button" className="sf-modal__close" onClick={onClose} aria-label="关闭">
              ×
            </button>
          ) : null}
        </div>
        <div className="sf-modal__body">{children}</div>
        {footer ? <div className="sf-modal__footer">{footer}</div> : null}
      </div>
    </div>
  );
}
