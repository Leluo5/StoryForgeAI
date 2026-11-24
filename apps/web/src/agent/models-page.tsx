import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { ModelListItem, ModelStatus, ModelProvider } from '@storyforge/contracts';
import { listModels, createModel, updateModel, deleteModel } from './model-client';
import './models-page.css';

const PROVIDER_LABEL: Record<ModelProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  mock: 'Mock',
  coze: 'Coze',
  flowise: 'Flowise',
  other: '其他'
};

const STATUS_LABEL: Record<ModelStatus, string> = {
  active: '启用',
  disabled: '停用'
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 新建/编辑模型的表单状态 */
interface ModelForm {
  id: string | null;
  name: string;
  provider: ModelProvider;
  model_id: string;
  context_window: string;
  supports_tools: boolean;
  supports_vision: boolean;
  input_price: string;
  output_price: string;
  currency: string;
  sort_order: string;
}

const EMPTY_FORM: ModelForm = {
  id: null, name: '', provider: 'openai', model_id: '', context_window: '',
  supports_tools: false, supports_vision: false, input_price: '', output_price: '',
  currency: 'USD', sort_order: ''
};

/** 表单 → 创建输入（数字字段转为 number，避免空字符串） */
function toCreateInput(form: ModelForm) {
  return {
    name: form.name,
    provider: form.provider,
    model_id: form.model_id,
    context_window: form.context_window === '' ? 0 : Number(form.context_window),
    supports_tools: form.supports_tools,
    supports_vision: form.supports_vision,
    input_price: form.input_price === '' ? 0 : Number(form.input_price),
    output_price: form.output_price === '' ? 0 : Number(form.output_price),
    currency: form.currency,
    sort_order: form.sort_order === '' ? 0 : Number(form.sort_order)
  };
}

/**
 * 模型管理页（/models）。
 * 列表 + 搜索（keyword/status 过滤）+ 创建/编辑（内联表单）+ 启用/停用 + 删除（直接硬删）。
 * 数据来自 /ai-models 全套接口。模型为「作者级选型目录」静态资源，非版本化，无归档/回滚。
 */
export function ModelsPage(): JSX.Element {
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  // 筛选/分页
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<ModelStatus | ''>('');
  const [page, setPage] = useState(1);
  const pageSize = 10;

  // 表单
  const [form, setForm] = useState<ModelForm | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listModels({
        ...(keyword ? { keyword } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
        page,
        page_size: pageSize
      });
      setModels(res.models);
      setTotal(res.total);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '模型加载失败');
      setModels([]);
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
    setForm({ ...EMPTY_FORM });
    setError('');
  }

  /** 打开编辑表单 */
  function startEdit(model: ModelListItem): void {
    if (busy) return;
    setForm({
      id: model.id,
      name: model.name,
      provider: model.provider,
      model_id: model.model_id,
      context_window: String(model.context_window),
      supports_tools: model.supports_tools,
      supports_vision: model.supports_vision,
      input_price: String(model.input_price),
      output_price: String(model.output_price),
      currency: model.currency,
      sort_order: String(model.sort_order)
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
      if (form.id) {
        await updateModel(form.id, toCreateInput(form));
      } else {
        await createModel(toCreateInput(form));
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
  async function toggleStatus(model: ModelListItem): Promise<void> {
    if (busy) return;
    setBusy(`status:${model.id}`);
    setError('');
    try {
      await updateModel(model.id, { status: model.status === 'active' ? 'disabled' : 'active' });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '状态切换失败');
    } finally {
      setBusy(null);
    }
  }

  /** 删除（直接硬删） */
  async function handleDelete(model: ModelListItem): Promise<void> {
    if (busy) return;
    if (!window.confirm(`确定删除「${model.name}」吗？删除后不可恢复。`)) return;
    setBusy(`delete:${model.id}`);
    setError('');
    try {
      await deleteModel(model.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="models-page">
      <div className="models-page__header">
        <div>
          <h1 className="models-page__title">模型管理</h1>
          <p className="models-page__subtitle">配置与管理 AI 模型选型目录：能力、价格与调用策略</p>
        </div>
        <button type="button" className="models-page__create" disabled={busy !== null} onClick={startCreate}>
          + 新建模型
        </button>
      </div>

      {/* 筛选工具栏 */}
      <div className="models-page__toolbar">
        <input
          type="search"
          className="models-page__search"
          placeholder="搜索模型名称 / 标识"
          value={keyword}
          onChange={(event) => { setKeyword(event.target.value); setPage(1); }}
          aria-label="搜索模型"
        />
        <select
          className="models-page__filter"
          value={statusFilter}
          onChange={(event) => { setStatusFilter(event.target.value as ModelStatus | ''); setPage(1); }}
          aria-label="按状态过滤"
        >
          <option value="">全部状态</option>
          <option value="active">启用</option>
          <option value="disabled">停用</option>
        </select>
      </div>

      {error && <p className="models-page__error" role="alert">{error}</p>}

      {/* 新建/编辑表单 */}
      {form && (
        <section className="models-page__form" aria-label={form.id ? '编辑模型' : '新建模型'}>
          <h2 className="models-page__form-title">{form.id ? '编辑模型' : '新建模型'}</h2>
          <div className="models-page__form-grid">
            <label className="models-page__form-field">
              <span>名称</span>
              <input type="text" value={form.name} maxLength={80} required
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="models-page__form-field">
              <span>厂商</span>
              <select value={form.provider}
                onChange={(e) => setForm({ ...form, provider: e.target.value as ModelProvider })}>
                {Object.entries(PROVIDER_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="models-page__form-field">
              <span>能力标识（model_id）</span>
              <input type="text" value={form.model_id} maxLength={80} required placeholder="gpt-4o-mini"
                onChange={(e) => setForm({ ...form, model_id: e.target.value })} />
            </label>
            <label className="models-page__form-field">
              <span>上下文窗口（tokens）</span>
              <input type="number" min={0} value={form.context_window} placeholder="128000"
                onChange={(e) => setForm({ ...form, context_window: e.target.value })} />
            </label>
            <label className="models-page__form-field">
              <span>输入价格（元/1K tokens）</span>
              <input type="number" min={0} step="any" value={form.input_price} placeholder="0.15"
                onChange={(e) => setForm({ ...form, input_price: e.target.value })} />
            </label>
            <label className="models-page__form-field">
              <span>输出价格（元/1K tokens）</span>
              <input type="number" min={0} step="any" value={form.output_price} placeholder="0.60"
                onChange={(e) => setForm({ ...form, output_price: e.target.value })} />
            </label>
            <label className="models-page__form-field">
              <span>货币</span>
              <input type="text" value={form.currency} maxLength={8} required
                onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
            </label>
            <label className="models-page__form-field">
              <span>排序权重</span>
              <input type="number" value={form.sort_order} placeholder="0"
                onChange={(e) => setForm({ ...form, sort_order: e.target.value })} />
            </label>
          </div>

          <div className="models-page__form-checks">
            <label className="models-page__form-check">
              <input type="checkbox" checked={form.supports_tools}
                onChange={(e) => setForm({ ...form, supports_tools: e.target.checked })} />
              <span>支持工具调用（tools）</span>
            </label>
            <label className="models-page__form-check">
              <input type="checkbox" checked={form.supports_vision}
                onChange={(e) => setForm({ ...form, supports_vision: e.target.checked })} />
              <span>支持视觉（vision）</span>
            </label>
          </div>

          <div className="models-page__form-actions">
            <button type="button" className="models-page__primary" disabled={busy !== null} onClick={() => void saveForm()}>
              {busy === 'save:create' || busy === 'save:edit' ? '保存中…' : '保存'}
            </button>
            <button type="button" className="models-page__secondary" disabled={busy !== null} onClick={cancelForm}>
              取消
            </button>
          </div>
        </section>
      )}

      {/* 列表 */}
      {loading && <p className="models-page__loading" role="status">正在加载模型</p>}

      {!loading && models.length === 0 && (
        <p className="models-page__empty">暂无模型，点击「新建模型」创建第一个。</p>
      )}

      {!loading && models.length > 0 && (
        <div className="models-page__list">
          {models.map((model) => (
            <article key={model.id} className="model-card">
              <div className="model-card__head">
                <div className="model-card__title-row">
                  <span className="model-card__name">{model.name}</span>
                  <span className={`model-card__badge model-card__badge--${model.status}`} data-status={model.status}>
                    {STATUS_LABEL[model.status]}
                  </span>
                </div>
                <div className="model-card__actions">
                  <button type="button" className="model-card__action" disabled={busy !== null}
                    onClick={() => void toggleStatus(model)}>{model.status === 'active' ? '停用' : '启用'}</button>
                  <button type="button" className="model-card__action" disabled={busy !== null}
                    onClick={() => startEdit(model)}>编辑</button>
                  <button type="button" className="model-card__action model-card__action--danger" disabled={busy !== null}
                    onClick={() => void handleDelete(model)}>删除</button>
                </div>
              </div>

              <div className="model-card__meta">
                <span className="model-card__meta-item">{PROVIDER_LABEL[model.provider]}</span>
                <span className="model-card__meta-item model-card__meta-item--mono">{model.model_id}</span>
                <span className="model-card__meta-item">{model.context_window > 0 ? `${model.context_window.toLocaleString()} ctx` : '—'}</span>
                <span className="model-card__meta-item">排序 {model.sort_order}</span>
                <span className="model-card__meta-item">更新 {formatDate(model.updated_at)}</span>
              </div>

              <div className="model-card__capabilities">
                <span className={`model-card__cap ${model.supports_tools ? 'model-card__cap--on' : 'model-card__cap--off'}`}>
                  工具调用 {model.supports_tools ? '✓' : '—'}
                </span>
                <span className={`model-card__cap ${model.supports_vision ? 'model-card__cap--on' : 'model-card__cap--off'}`}>
                  视觉 {model.supports_vision ? '✓' : '—'}
                </span>
                <span className="model-card__cap model-card__cap--price">
                  输入 {model.input_price} {model.currency} / 1K
                </span>
                <span className="model-card__cap model-card__cap--price">
                  输出 {model.output_price} {model.currency} / 1K
                </span>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* 分页 */}
      {!loading && totalPages > 1 && (
        <div className="models-page__pagination">
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
