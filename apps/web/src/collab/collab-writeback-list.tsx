import { useCallback, useEffect, useState, type JSX } from 'react';
import type { CollabRoleField, CollabWriteback, CollabWritebackField } from '@storyforge/contracts';
import type { CollabClient } from './collab-client';
import { CollabRevertDialog } from './collab-revert-dialog';
import './collab-panel.css';

const FIELD_LABEL: Record<CollabRoleField, string> = {
  identity: '身份定位',
  personality: '性格',
  experience: '经历'
};

interface Props {
  workId: string;
  characterId: string;
  client: CollabClient;
}

/** 待撤销的目标字段行（弹窗入参） */
interface PendingRevert {
  writebackId: string;
  field: CollabWritebackField;
}

/**
 * F11 写回历史列表（T19）：按角色列写回单，每字段行提供「撤销」入口（已撤销置灰）。
 * 撤销入口仅对 status=applied 且 field.status=applied 的字段显示。
 */
export function CollabWritebackList({ workId, characterId, client }: Props): JSX.Element {
  const [writebacks, setWritebacks] = useState<CollabWriteback[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PendingRevert | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await client.listWritebacks(workId, characterId);
      setWritebacks(rows);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '写回历史加载失败');
    } finally {
      setLoading(false);
    }
  }, [client, workId, characterId]);

  useEffect(() => { void load(); }, [load]);

  const onReverted = useCallback((fieldKey: CollabRoleField, writebackId: string) => {
    setWritebacks((prev) => prev.map((writeback) => (
      writeback.id === writebackId
        ? {
            ...writeback,
            fields: writeback.fields.map((field) => (
              field.field_key === fieldKey ? { ...field, status: 'reverted' as const } : field
            ))
          }
        : writeback
    )));
    setPending(null);
  }, []);

  if (loading) return <div className="collab-card"><div className="collab-card-title">写回历史</div><div className="collab-muted">加载写回历史…</div></div>;

  return (
    <div className="collab-card">
      <div className="collab-card-title">写回历史（{writebacks.length}）</div>
      {error && <div className="collab-error">{error}</div>}
      {writebacks.length === 0 && <div className="collab-note">暂无写回记录。</div>}
      <div className="collab-list">
        {writebacks.map((writeback) => (
          <div key={writeback.id} className="collab-writeback">
            <div className="collab-item-sub">
              任务 {writeback.task_id.slice(0, 8)}… · {writeback.channel} · {writeback.status}
            </div>
            <div className="collab-fields">
              {writeback.fields.map((field) => {
                const reverting = field.status === 'applied';
                return (
                  <div key={field.field_key} className="collab-writeback-field">
                    <span className="collab-item-title">{FIELD_LABEL[field.field_key]}</span>
                    <span className="collab-item-sub">新值：{field.after_value ? String(field.after_value) : '（空）'}</span>
                    <button
                      type="button"
                      className="collab-btn collab-btn-small"
                      disabled={!reverting}
                      onClick={() => setPending({ writebackId: writeback.id, field })}
                    >
                      {field.status === 'reverted' ? '已撤销' : '撤销'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {pending && (
        <CollabRevertDialog
          workId={workId}
          writebackId={pending.writebackId}
          field={pending.field}
          client={client}
          onClose={() => setPending(null)}
          onReverted={(fieldKey) => onReverted(fieldKey, pending.writebackId)}
        />
      )}
    </div>
  );
}
