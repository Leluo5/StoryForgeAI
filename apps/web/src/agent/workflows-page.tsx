import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { WorkflowListItem, WorkflowStatus, WorkflowPlatform, WorkflowVersionSummary } from '@storyforge/contracts';
import {
  listWorkflows,
  createWorkflow,
  updateWorkflow,
  archiveWorkflow,
  restoreWorkflow,
  deleteWorkflow,
  listWorkflowVersions,
  rollbackWorkflow
} from './workflow-client';
import './workflows-page.css';

const PLATFORM_LABEL: Record<WorkflowPlatform, string> = {
  coze: 'Coze'
};

const STATUS_LABEL: Record<WorkflowStatus, string> = {
  active: '启用',
  disabled: '停用',
  archived: '已归档'
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 新建/编辑工作流的表单状态 */
interface WorkflowForm {
  id: string | null;
  name: string;
  description: string;
  model: string;
  workflow_id: string;
  workspace_id: string;
}

const EMPTY_FORM: WorkflowForm = {
  id: null, name: '', description: '', model: '', workflow_id: '', workspace_id: ''
};

/**
 * 工作流管理页（/workflows）。
 * 列表 + 搜索（keyword/status 过滤）+ 创建/编辑（内联表单）+ 启用/停用 + 归档/恢复 + 版本历史回滚。
 * 数据来自 /ai-workflows 全套接口，视觉交互对齐智能体管理模块。
 */
export function WorkflowsPage(): JSX.Element {
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  // 筛选/分页
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<WorkflowStatus | ''>('');
  const [page, setPage] = useState(1);
  const pageSize = 10;

  // 表单
  const [form, setForm] = useState<WorkflowForm | null>(null);

  // 版本历史面板（key=workflowId）
  const [versionsOpen, setVersionsOpen] = useState<string | null>(null);
  const [versions, setVersions] = useState<WorkflowVersionSummary[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listWorkflows({
        ...(keyword ? { keyword } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
        page,
        page_size: pageSize
      });
      setWorkflows(res.workflows);
      setTotal(res.total);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '工作流加载失败');
      setWorkflows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [keyword, statusFilter, page]);

  useEffect(() => { void load(); }, [load]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [total, pageSize]);

  /** 打开新建表单 */
  function startCreate(): void {
    if (busy) return;
    setForm({ ...EMPTY_FORM, model: 'gpt-4o-mini' });
    setError('');
  }

  /** 打开编辑表单 */
  function startEdit(wf: WorkflowListItem): void {
    if (busy) return;
    setForm({
      id: wf.id,
      name: wf.name,
      description: wf.description ?? '',
      model: wf.llm_config?.model ?? '',
      workflow_id: wf.platform_config?.workflow_id ?? '',
      workspace_id: wf.platform_config?.workspace_id ?? ''
    });
    setError('');
  }

  function cancelForm(): void {
    setForm(null);
  }

  /** 保存（创建或更新） */
  async function saveForm(): Promise<void> {
    if (!form || busy) return;
    setBusy(form.id ? 'save:edit' : 'save:create');
    setError('');
    try {
      const platform_config = {
        ...(form.workflow_id ? { workflow_id: form.workflow_id } : {}),
        ...(form.workspace_id ? { workspace_id: form.workspace_id } : {})
      };
      if (form.id) {
        await updateWorkflow(form.id, {
          name: form.name,
          description: form.description,
          llm_config: { model: form.model },
          ...(Object.keys(platform_config).length ? { platform_config } : {})
        });
      } else {
        await createWorkflow({
          name: form.name,
          description: form.description,
          llm_config: { model: form.model },
          platform_config
        });
      }
      setForm(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setBusy(null);
    }
  }

  /** 切换启用/停用 */
  async function toggleStatus(wf: WorkflowListItem): Promise<void> {
    if (busy) return;
    setBusy(`status:${wf.id}`);
    setError('');
    try {
      await updateWorkflow(wf.id, { status: wf.status === 'active' ? 'disabled' : 'active' });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '状态切换失败');
    } finally {
      setBusy(null);
    }
  }

  /** 归档 */
  async function handleArchive(wf: WorkflowListItem): Promise<void> {
    if (busy) return;
    if (!window.confirm(`确定归档「${wf.name}」吗？归档后可恢复，也可删除。`)) return;
    setBusy(`archive:${wf.id}`);
    setError('');
    try {
      await archiveWorkflow(wf.id, { note: '手动归档' });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '归档失败');
    } finally {
      setBusy(null);
    }
  }

  /** 恢复 */
  async function handleRestore(wf: WorkflowListItem): Promise<void> {
    if (busy) return;
    setBusy(`restore:${wf.id}`);
    setError('');
    try {
      await restoreWorkflow(wf.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '恢复失败');
    } finally {
      setBusy(null);
    }
  }

  /** 删除（已归档直接删；未归档弹确认后强制删） */
  async function handleDelete(wf: WorkflowListItem): Promise<void> {
    if (busy) return;
    const msg = wf.status === 'archived'
      ? `确定删除「${wf.name}」吗？删除后不可恢复。`
      : `「${wf.name}」尚未归档，删除需强制。确定删除吗？`;
    if (!window.confirm(msg)) return;
    setBusy(`delete:${wf.id}`);
    setError('');
    try {
      await deleteWorkflow(wf.id, true);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      setBusy(null);
    }
  }

  /** 打开/关闭版本历史 */
  async function toggleVersions(wf: WorkflowListItem): Promise<void> {
    if (versionsOpen === wf.id) { setVersionsOpen(null); return; }
    setVersionsOpen(wf.id);
    setVersionsLoading(true);
    setVersions([]);
    try {
      const res = await listWorkflowVersions(wf.id);
      setVersions(res.versions);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '版本加载失败');
    } finally {
      setVersionsLoading(false);
    }
  }

  /** 回滚到指定版本 */
  async function handleRollback(wf: WorkflowListItem, versionNo: number): Promise<void> {
    if (busy) return;
    if (!window.confirm(`确定回滚「${wf.name}」到 v${versionNo} 吗？当前内容将被该版本快照覆盖。`)) return;
    setBusy(`rollback:${wf.id}:${versionNo}`);
    setError('');
    try {
      await rollbackWorkflow(wf.id, versionNo, { note: `回滚至 v${versionNo}` });
      setVersionsOpen(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '回滚失败');
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="workflows-page">
      <div className="workflows-page__header">
        <div>
          <h1 className="workflows-page__title">工作流管理</h1>
          <p className="workflows-page__subtitle">编排创作工作流：自动化流程与规则配置</p>
        </div>
        <button type="button" className="workflows-page__create" disabled={busy !== null} onClick={startCreate}>
          + 新建工作流
        </button>
      </div>

      {/* 筛选工具栏 */}
      <div className="workflows-page__toolbar">
        <input
          type="search"
          className="workflows-page__search"
          placeholder="搜索工作流名称 / 描述"
          value={keyword}
          onChange={(event) => { setKeyword(event.target.value); setPage(1); }}
          aria-label="搜索工作流"
        />
        <select
          className="workflows-page__filter"
          value={statusFilter}
          onChange={(event) => { setStatusFilter(event.target.value as WorkflowStatus | ''); setPage(1); }}
          aria-label="按状态过滤"
        >
          <option value="">全部状态</option>
          <option value="active">启用</option>
          <option value="disabled">停用</option>
          <option value="archived">已归档</option>
        </select>
      </div>

      {error && <p className="workflows-page__error" role="alert">{error}</p>}

      {/* 新建/编辑表单 */}
      {form && (
        <section className="workflows-page__form" aria-label={form.id ? '编辑工作流' : '新建工作流'}>
          <h2 className="workflows-page__form-title">{form.id ? '编辑工作流' : '新建工作流'}</h2>
          <div className="workflows-page__form-grid">
            <label className="workflows-page__form-field">
              <span>名称</span>
              <input type="text" value={form.name} maxLength={80} required
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="workflows-page__form-field">
              <span>描述</span>
              <textarea rows={2} value={form.description} maxLength={500}
                onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </label>
            <label className="workflows-page__form-field">
              <span>模型（llm_config.model）</span>
              <input type="text" value={form.model} placeholder="gpt-4o-mini" required
                onChange={(e) => setForm({ ...form, model: e.target.value })} />
            </label>
            <label className="workflows-page__form-field">
              <span>平台工作流 ID（可选）</span>
              <input type="text" value={form.workflow_id} placeholder="workflow_id"
                onChange={(e) => setForm({ ...form, workflow_id: e.target.value })} />
            </label>
            <label className="workflows-page__form-field">
              <span>工作空间 ID（可选）</span>
              <input type="text" value={form.workspace_id} placeholder="workspace_id"
                onChange={(e) => setForm({ ...form, workspace_id: e.target.value })} />
            </label>
          </div>
          <div className="workflows-page__form-actions">
            <button type="button" className="workflows-page__primary" disabled={busy !== null} onClick={() => void saveForm()}>
              {busy === 'save:create' || busy === 'save:edit' ? '保存中…' : '保存'}
            </button>
            <button type="button" className="workflows-page__secondary" disabled={busy !== null} onClick={cancelForm}>
              取消
            </button>
          </div>
        </section>
      )}

      {/* 列表 */}
      {loading && <p className="workflows-page__loading" role="status">正在加载工作流</p>}

      {!loading && workflows.length === 0 && (
        <p className="workflows-page__empty">暂无工作流，点击「新建工作流」创建第一个。</p>
      )}

      {!loading && workflows.length > 0 && (
        <div className="workflows-page__list">
          {workflows.map((wf) => (
            <article key={wf.id} className="workflow-card">
              <div className="workflow-card__head">
                <div className="workflow-card__title-row">
                  <span className="workflow-card__name">{wf.name}</span>
                  <span className={`workflow-card__badge workflow-card__badge--${wf.status}`} data-status={wf.status}>
                    {STATUS_LABEL[wf.status]}
                  </span>
                </div>
                <div className="workflow-card__actions">
                  {wf.status === 'archived' ? (
                    <>
                      <button type="button" className="workflow-card__action" disabled={busy !== null}
                        onClick={() => void handleRestore(wf)}>恢复</button>
                      <button type="button" className="workflow-card__action workflow-card__action--danger" disabled={busy !== null}
                        onClick={() => void handleDelete(wf)}>删除</button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="workflow-card__action" disabled={busy !== null}
                        onClick={() => void toggleStatus(wf)}>{wf.status === 'active' ? '停用' : '启用'}</button>
                      <button type="button" className="workflow-card__action" disabled={busy !== null}
                        onClick={() => startEdit(wf)}>编辑</button>
                      <button type="button" className="workflow-card__action" disabled={busy !== null}
                        onClick={() => void handleArchive(wf)}>归档</button>
                      <button type="button" className="workflow-card__action workflow-card__action--danger" disabled={busy !== null}
                        onClick={() => void handleDelete(wf)}>删除</button>
                    </>
                  )}
                </div>
              </div>

              {wf.description && <p className="workflow-card__desc">{wf.description}</p>}

              <div className="workflow-card__meta">
                <span className="workflow-card__meta-item">{PLATFORM_LABEL[wf.platform]}</span>
                <span className="workflow-card__meta-item">模型：{wf.llm_config?.model ?? '—'}</span>
                <span className="workflow-card__meta-item">v{wf.version_no}</span>
                <span className="workflow-card__meta-item">更新 {formatDate(wf.updated_at)}</span>
              </div>

              {/* 版本历史（可折叠） */}
              <button type="button" className="workflow-card__versions-toggle"
                onClick={() => void toggleVersions(wf)}>
                {versionsOpen === wf.id ? '收起版本历史' : '查看版本历史'}
              </button>
              {versionsOpen === wf.id && (
                <div className="workflow-card__versions">
                  {versionsLoading && <p className="workflow-card__versions-empty">正在加载版本…</p>}
                  {!versionsLoading && versions.length === 0 && (
                    <p className="workflow-card__versions-empty">暂无版本记录</p>
                  )}
                  {!versionsLoading && versions.map((v) => (
                    <div key={v.version_no} className="workflow-card__version">
                      <span className="workflow-card__version-no" data-version-no={v.version_no}>v{v.version_no}</span>
                      <span className="workflow-card__version-type">{v.change_type}</span>
                      <span className="workflow-card__version-note">{v.note || '—'}</span>
                      <span className="workflow-card__version-time">{formatDate(v.created_at)}</span>
                      {v.version_no !== wf.version_no && (
                        <button type="button" className="workflow-card__action workflow-card__action--rollback"
                          disabled={busy !== null}
                          onClick={() => void handleRollback(wf, v.version_no)}>回滚到此版本</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {/* 分页 */}
      {!loading && totalPages > 1 && (
        <div className="workflows-page__pagination">
          <button type="button" disabled={page <= 1 || busy !== null}
            onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</button>
          <span>第 {page} / {totalPages} 页（共 {total} 条）</span>
          <button type="button" disabled={page >= totalPages || busy !== null}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>下一页</button>
        </div>
      )}
    </main>
  );
}
