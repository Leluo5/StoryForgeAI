import { type JSX } from 'react';
import type { CollabArchiveStatus } from '@storyforge/contracts';
import './collab-panel.css';

const STATUS_LABEL: Record<CollabArchiveStatus, string> = {
  pending: '待投递',
  delivered: '已投递',
  failed: '投递失败'
};

interface Props {
  status: CollabArchiveStatus;
  attempts: number;
  externalId?: string | null;
  deliveredAt?: string | null;
}

/**
 * F11 归档状态（T19）：展示 n8n 归档 outbox 的投递状态与重试次数。
 */
export function CollabArchiveStatus({ status, attempts, externalId, deliveredAt }: Props): JSX.Element {
  return (
    <div className="collab-archive">
      <span className={`collab-tag ${status === 'delivered' ? '' : status === 'failed' ? 'collab-tag-danger' : ''}`}>
        {STATUS_LABEL[status]}
      </span>
      <span className="collab-item-sub">尝试 {attempts} 次</span>
      {externalId && <span className="collab-item-sub">外部 {externalId}</span>}
      {deliveredAt && <span className="collab-item-sub">投递于 {new Date(deliveredAt).toLocaleString()}</span>}
    </div>
  );
}
