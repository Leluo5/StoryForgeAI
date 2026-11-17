import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { CompareVersionsResponse, VersionSummary } from '@storyforge/contracts';
import {
  compareVersions, confirmRollback, createVersion, getVersion, listVersions, rollback
} from './revision-client';
import './version-panel.css';

interface VersionPanelProps {
  workId: string;
  chapterId: string;
}

const CHANGE_LABEL: Record<VersionSummary['change_type'], string> = {
  manual: '手动',
  auto: '自动'
};

function DiffView({ diff }: { diff: CompareVersionsResponse }): JSX.Element {
  return <div className="version-diff">
    <section aria-label="节点变更">
      <h4>节点变更</h4>
      {diff.node_changes.length === 0
        ? <p className="version-empty">无节点变更</p>
        : <ul className="version-node-changes">
            {diff.node_changes.map((change) => (
              <li key={`${change.node_path}:${change.change}`} className={`version-node-${change.change}`}>
                <span className="version-node-path">#{change.node_path}</span>
                <span>{change.change === 'added' ? '新增' : change.change === 'removed' ? '删除' : '修改'}</span>
              </li>
            ))}
          </ul>}
    </section>
    <section aria-label="正文差异">
      <h4>正文差异</h4>
      {diff.text_diff.length === 0
        ? <p className="version-empty">无正文差异</p>
        : <pre className="version-text-diff">
            {diff.text_diff.map((part, index) => (
              <span key={index} className={`version-text-${part.kind}`}>
                {part.kind === 'insert' ? '+ ' : part.kind === 'delete' ? '- ' : '  '}{part.text}
              </span>
            ))}
          </pre>}
    </section>
  </div>;
}

export function VersionPanel({ workId, chapterId }: VersionPanelProps) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ from: number | null; to: number | null }>({ from: null, to: null });
  const [diff, setDiff] = useState<CompareVersionsResponse | null>(null);
  const [rollbackState, setRollbackState] = useState<{
    versionNo: number; revisionSetId: string; preview: Record<string, unknown> | null;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await listVersions(workId, chapterId);
      setVersions(result.versions);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '版本加载失败');
    } finally { setLoading(false); }
  }, [workId, chapterId]);
  useEffect(() => { void load(); }, [load]);

  const ordered = useMemo(() => [...versions].sort((a, b) => b.version_no - a.version_no), [versions]);

  async function createManualVersion(): Promise<void> {
    if (busy) return;
    setBusy('create'); setError('');
    try {
      await createVersion(workId, chapterId, { note: '手动快照' });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '版本创建失败');
    } finally { setBusy(null); }
  }

  async function runCompare(): Promise<void> {
    const { from, to } = selected;
    if (from === null || to === null || from === to) { setError('请选择两个不同版本'); return; }
    setBusy('compare'); setError('');
    try {
      setDiff(await compareVersions(workId, chapterId, { from_version_no: from, to_version_no: to }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '对比失败');
    } finally { setBusy(null); }
  }

  async function startRollback(versionNo: number): Promise<void> {
    setBusy(`rollback:${versionNo}`); setError('');
    try {
      const result = await rollback(workId, chapterId, versionNo);
      setRollbackState({ versionNo, revisionSetId: result.revision_set.id, preview: result.preview });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '回滚失败');
    } finally { setBusy(null); }
  }

  async function confirmRollbackAction(): Promise<void> {
    if (!rollbackState) return;
    setBusy('confirm'); setError('');
    try {
      await confirmRollback(workId, rollbackState.revisionSetId);
      setRollbackState(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '回滚确认失败');
    } finally { setBusy(null); }
  }

  if (loading) return <p role="status">正在加载版本</p>;
  return <div className="version-panel">
    <h2>版本历史</h2>
    {error && <p role="alert">{error}</p>}
    <div className="version-actions">
      <button type="button" disabled={busy !== null} onClick={() => void createManualVersion()}>
        {busy === 'create' ? '创建中' : '创建当前版本快照'}
      </button>
    </div>

    <section className="version-compare" aria-label="版本对比">
      <h3>对比</h3>
      <div className="version-compare-controls">
        <label htmlFor="version-from">从</label>
        <select id="version-from" value={selected.from ?? ''}
          onChange={(event) => setSelected((current) => ({ ...current, from: event.target.value ? Number(event.target.value) : null }))}>
          <option value="">选择版本</option>
          {ordered.map((v) => <option key={v.id} value={v.version_no}>v{v.version_no}</option>)}
        </select>
        <label htmlFor="version-to">到</label>
        <select id="version-to" value={selected.to ?? ''}
          onChange={(event) => setSelected((current) => ({ ...current, to: event.target.value ? Number(event.target.value) : null }))}>
          <option value="">选择版本</option>
          {ordered.map((v) => <option key={v.id} value={v.version_no}>v{v.version_no}</option>)}
        </select>
        <button type="button" disabled={busy !== null || selected.from === null || selected.to === null}
          onClick={() => void runCompare()}>对比</button>
      </div>
      {diff && <DiffView diff={diff} />}
    </section>

    <ul className="version-list">
      {ordered.map((version) => (
        <li key={version.id} className="version-row">
          <header className="version-row-head">
            <span className="version-no">v{version.version_no}</span>
            <span className="version-change">{CHANGE_LABEL[version.change_type]}</span>
            <time dateTime={version.created_at}>{new Date(version.created_at).toLocaleString()}</time>
          </header>
          {version.note && <p className="version-note">{version.note}</p>}
          <div className="version-row-actions">
            <button type="button" disabled={busy !== null}
              onClick={() => void getVersion(workId, chapterId, version.version_no).then((result) => {
                // 预览快照：仅提示，完整渲染交由编辑器
                setError(`快照 v${version.version_no} 已加载，哈希 ${result.snapshot.content_hash.slice(0, 12)}…`);
              }).catch((cause) => setError(cause instanceof Error ? cause.message : '加载失败'))}>
              查看
            </button>
            <button type="button" disabled={busy !== null || version.change_type === 'auto'}
              onClick={() => void startRollback(version.version_no)}>回滚</button>
          </div>
        </li>
      ))}
    </ul>

    {rollbackState && (
      <div className="version-rollback-dialog" role="dialog" aria-modal="true" aria-label="回滚确认">
        <h3>确认回滚到 v{rollbackState.versionNo}？</h3>
        <p>将基于该快照生成回滚修订集，确认后成为当前正文。</p>
        <div className="version-rollback-actions">
          <button type="button" disabled={busy !== null} onClick={() => void confirmRollbackAction()}>
            {busy === 'confirm' ? '确认中' : '确认回滚'}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => setRollbackState(null)}>取消</button>
        </div>
      </div>
    )}
  </div>;
}
