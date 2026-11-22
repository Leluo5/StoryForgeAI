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
/**
 * 保存状态视图：仅渲染状态文本（小字淡灰，紧跟作品名）。
 * 「接管写入」按钮已上移到工作台页头第二行（需求二），由 workbench-page 直接渲染并复用 onTakeover；
 * 本组件保留 onTakeover 入参以兼容既有调用签名与测试。
 */
export function SaveStatusView({ status, onRetry, onRestore }: Props) {
  return <div className="save-status" role="status" aria-live="polite">{labels[status]}
    {['offline_pending', 'save_failed'].includes(status) && <button type="button" onClick={onRetry}>重试</button>}
    {status === 'save_failed' && <button type="button" onClick={() => {
      // 服务端恢复会清除未确认日志，必须经用户二次确认
      if (window.confirm('从服务端恢复会保留本地备份并清除未确认日志，确认继续？')) onRestore();
    }}>从服务端恢复</button>}
  </div>;
}