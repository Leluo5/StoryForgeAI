import { useState } from 'react';
import type { CozeResourceItem, CozeImportResponse } from '@storyforge/contracts';
import { testCoze, listCozeResources, importCozeResources } from './coze-import-client';

/**
 * F1 从 Coze 拉取并批量导入（智能体/知识库）。
 * 独立面板，挂在 /admin 平台凭据区下方；复用 credentials.cozePat 作为默认 PAT。
 */
export function CozeImportPanel({ defaultPat, onSaved }: { defaultPat: string; onSaved?: (msg: string) => void }): JSX.Element {
  const [pat, setPat] = useState(defaultPat);
  const [workspaceId, setWorkspaceId] = useState('');
  const [resources, setResources] = useState<CozeResourceItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<CozeImportResponse | null>(null);
  const [busy, setBusy] = useState<'test' | 'list' | 'import' | null>(null);
  const [message, setMessage] = useState('');

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleTest = async () => {
    setBusy('test');
    setMessage('');
    try {
      const res = await testCoze(pat);
      setMessage(res.ok ? '连接成功' : '连接失败：请检查 PAT 与接口地址');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '连接失败');
    } finally {
      setBusy(null);
    }
  };

  const handleList = async () => {
    setBusy('list');
    setMessage('');
    try {
      const res = await listCozeResources(pat, workspaceId || undefined);
      setResources(res.resources);
      setSelected(new Set());
      setMessage(`拉取到 ${res.resources.length} 个资源`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '拉取失败');
    } finally {
      setBusy(null);
    }
  };

  const handleImport = async () => {
    if (selected.size === 0) {
      setMessage('请先勾选要导入的资源');
      return;
    }
    setBusy('import');
    setMessage('');
    try {
      const items = resources.filter((r) => selected.has(r.id)).map((r) => ({ id: r.id, type: r.type }));
      const res = await importCozeResources({ pat_token: pat, items });
      setResult(res);
      setMessage(`导入完成：成功 ${res.imported} / ${res.total}`);
      onSaved?.(`从 Coze 导入 ${res.imported} 项`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '导入失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="admin-section">
      <h2 className="admin-section__title">从 Coze 拉取</h2>
      <p className="admin-section__hint">拉取 Coze 智能体与知识库，导入为本站智能体/知识库条目。</p>
      <div className="admin-field">
        <label className="admin-field__label" htmlFor="coze-import-pat">PAT 令牌</label>
        <input
          id="coze-import-pat"
          className="admin-field__input"
          type="password"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          placeholder="pat_..."
        />
      </div>
      <div className="admin-field">
        <label className="admin-field__label" htmlFor="coze-import-ws">工作空间 ID（可选）</label>
        <input
          id="coze-import-ws"
          className="admin-field__input"
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
          placeholder="workspace_id"
        />
      </div>
      <div className="admin-page__actions">
        <button type="button" className="admin-page__save" onClick={() => void handleTest()} disabled={busy !== null}>
          {busy === 'test' ? '测试中…' : '测试连接'}
        </button>
        <button type="button" className="admin-page__save" onClick={() => void handleList()} disabled={busy !== null}>
          {busy === 'list' ? '拉取中…' : '拉取资源'}
        </button>
        <button type="button" className="admin-page__save" onClick={() => void handleImport()} disabled={busy !== null || selected.size === 0}>
          {busy === 'import' ? '导入中…' : `导入所选（${selected.size}）`}
        </button>
      </div>
      {message && <p className="admin-field__error">{message}</p>}
      {resources.length > 0 && (
        <ul className="coze-import-list">
          {resources.map((r) => (
            <li key={r.id} className="coze-import-item">
              <label className="coze-import-item__label">
                <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                <span className={`coze-import-item__type coze-import-item__type--${r.type}`}>{r.type === 'bot' ? '智能体' : '知识库'}</span>
                <span className="coze-import-item__name">{r.name}</span>
              </label>
              {r.description && <span className="coze-import-item__desc">{r.description}</span>}
            </li>
          ))}
        </ul>
      )}
      {result && (
        <ul className="coze-import-result">
          {result.results.map((r) => (
            <li key={`${r.type}-${r.id}`} className={`coze-import-result__item ${r.success ? 'is-success' : 'is-error'}`}>
              <span>{r.name}</span>
              <span>{r.success ? '成功' : r.error ?? '失败'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
