import type { SaveStatus } from './use-chapter-writer';

const labels: Record<SaveStatus, string> = {
  local_saving: '本地保存中', local_saved: '本地已保存', syncing: '云端同步中', synced: '已同步',
  offline_pending: '离线待同步', conflict: '版本冲突', save_failed: '保存失败', recovering: '正在恢复', read_only: '只读'
};
interface Props {
  status: SaveStatus;
  onRetry(): void;
  onTakeover(): void;
  onRestore(): void;
}
export function SaveStatusView({ status, onRetry, onTakeover, onRestore }: Props) {
  return <div role="status" aria-live="polite">{labels[status]}
    {['offline_pending', 'save_failed'].includes(status) && <button type="button" onClick={onRetry}>重试</button>}
    {status === 'save_failed' && <button type="button" onClick={() => {
      // 服务端恢复会清除未确认日志，必须经用户二次确认
      if (window.confirm('从服务端恢复会保留本地备份并清除未确认日志，确认继续？')) onRestore();
    }}>从服务端恢复</button>}
    {status === 'read_only' && <button type="button" onClick={onTakeover}>接管写入</button>}
  </div>;
}
