import { useCallback, useRef, useState, type JSX } from 'react';
import type { CollabRoleField, CollabWritebackField } from '@storyforge/contracts';
import type { CollabClient } from './collab-client';
import { COLLAB_FIELD_LABEL, collabErrorMessage } from './collab-state';
import './collab.css';

const FIELD_LABEL = COLLAB_FIELD_LABEL;

interface Props {
  workId: string;
  writebackId: string;
  /** 待撤销字段行（含当前/先前值与是否已撤销） */
  field: CollabWritebackField;
  client: CollabClient;
  onClose: () => void;
  onReverted?: (fieldKey: CollabRoleField) => void;
}

/**
 * F11 写回撤销弹窗（T19）：展示冲突前后值 + 二次确认。
 * 已撤销字段不显示「确认撤销」按钮；撤销请求期间按钮禁用；aria-live 播报结果。
 */
export function CollabRevertDialog({ workId, writebackId, field, client, onClose, onReverted }: Props): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [error, setError] = useState('');
  const [announce, setAnnounce] = useState('');
  const liveRef = useRef<HTMLDivElement>(null);

  const runRevert = useCallback(async () => {
    setReverting(true);
    setError('');
    try {
      await client.revertWritebackField(workId, writebackId, field.field_key);
      setAnnounce(`已撤销 ${FIELD_LABEL[field.field_key]}`);
      onReverted?.(field.field_key);
      onClose();
    } catch (cause) {
      const message = collabErrorMessage(cause);
      setError(message);
      setAnnounce(message);
    } finally {
      setReverting(false);
    }
  }, [client, workId, writebackId, field.field_key, onReverted, onClose]);

  const alreadyReverted = field.status === 'reverted';

  return (
    <div className="collab-modal-backdrop" role="presentation" onClick={onClose}>
      <div className="collab-modal" role="dialog" aria-modal="true" aria-label={`撤销 ${FIELD_LABEL[field.field_key]}`} onClick={(e) => e.stopPropagation()}>
        <div className="collab-card-title">撤销「{FIELD_LABEL[field.field_key]}」</div>

        <div className="collab-block">
          <div className="collab-item">
            <div className="collab-item-sub">先前值</div>
            <div className="collab-item-title">{field.before_value ? String(field.before_value) : '（空）'}</div>
          </div>
          <div className="collab-item">
            <div className="collab-item-sub">当前值（AI 写回）</div>
            <div className="collab-item-title">{field.after_value ? String(field.after_value) : '（空）'}</div>
          </div>
        </div>

        {alreadyReverted ? (
          <div className="collab-note">该字段已撤销，无需重复操作。</div>
        ) : (
          <div className="collab-block">
            <div className="collab-note">
              撤销将把「{FIELD_LABEL[field.field_key]}」恢复为先前值。此操作仅影响该字段，其余字段不受影响。
            </div>
          </div>
        )}

        {error && <div className="collab-error" role="alert">{error}</div>}

        <div className="collab-actions">
          <button type="button" className="collab-btn collab-btn-ghost" onClick={onClose} disabled={reverting}>取消</button>
          {!alreadyReverted && (
            <button
              type="button"
              className="collab-btn collab-btn-danger"
              disabled={reverting || !confirming}
              onClick={() => void runRevert()}
            >
              {reverting ? '撤销中…' : confirming ? '确认撤销' : '撤销'}
            </button>
          )}
        </div>
        {!alreadyReverted && !confirming && !reverting && (
          <button type="button" className="collab-link" onClick={() => setConfirming(true)}>
            再次确认
          </button>
        )}

        <div ref={liveRef} className="collab-sr-only" aria-live="polite">{announce}</div>
      </div>
    </div>
  );
}
