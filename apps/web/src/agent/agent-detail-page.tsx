import { useCallback, useEffect, useState, type JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AgentListItem, AiToolListItem, AgentPlatform, AgentStatus } from '@storyforge/contracts';
import { getAgentDetail, updateAgent, updateTool, DEFAULT_MODEL_CONFIG } from './agent-client';
import './agent-detail-page.css';

/** 平台 / 状态中文标签（与 agent-panel 保持一致） */
const PLATFORM_LABEL: Record<AgentPlatform, string> = {
  mock: 'Mock（内置）',
  coze: 'Coze（预留）',
  flowise: 'Flowise（自建）'
};

function statusText(status: AgentStatus): string {
  return status === 'active' ? '启用' : '停用';
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 模型配置编辑表单状态 */
interface ModelEdit {
  modelId: string;
  temperature: string;
  maxTokens: string;
}

/** 工具编辑表单状态（key=tool_id） */
interface ToolEdit {
  toolId: string;
  name: string;
  description: string;
  enabled: boolean;
}

/**
 * 智能体详情页（/agents/:agentId）。
 * 展示：基础常规信息（状态/平台/默认/创建时间等）、已绑定工具列表、模型配置、描述。
 * 模型配置与工具列表均支持就地编辑（PATCH /ai-agents/:id 与 /ai-tools/:toolId）。
 * 全局 Agent 为作者级 legacy 配置，无作品级角色绑定，角色设定模块以空状态占位说明。
 */
export function AgentDetailPage(): JSX.Element {
  const { agentId } = useParams<{ agentId: string }>();
  const [agent, setAgent] = useState<AgentListItem | null>(null);
  const [tools, setTools] = useState<AiToolListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // 编辑状态：null=未编辑；model=模型配置；tool:<tool_id>=对应工具
  const [editing, setEditing] = useState<string | null>(null);
  const [modelEdit, setModelEdit] = useState<ModelEdit | null>(null);
  const [toolEdit, setToolEdit] = useState<ToolEdit | null>(null);

  const load = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    try {
      const detail = await getAgentDetail(agentId);
      setAgent(detail.agent);
      setTools(detail.tools);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Agent 详情加载失败');
      setAgent(null);
      setTools([]);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

  /** 刷新详情（编辑成功后调用，保持编辑态关闭） */
  async function refresh(): Promise<void> {
    setEditing(null);
    setModelEdit(null);
    setToolEdit(null);
    await load();
  }

  /** 打开模型配置编辑表单 */
  function startModelEdit(): void {
    if (!agent || busy) return;
    setModelEdit({
      modelId: agent.model_id,
      temperature: String(agent.model_config.temperature ?? 0.7),
      maxTokens: String(agent.model_config.max_tokens ?? 2048)
    });
    setEditing('model');
    setError('');
  }

  /** 打开工具编辑表单 */
  function startToolEdit(tool: AiToolListItem): void {
    if (busy) return;
    setToolEdit({
      toolId: tool.tool_id,
      name: tool.name,
      description: tool.description ?? '',
      enabled: tool.enabled
    });
    setEditing(`tool:${tool.tool_id}`);
    setError('');
  }

  /** 取消编辑 */
  function cancelEdit(): void {
    setEditing(null);
    setModelEdit(null);
    setToolEdit(null);
  }

  /** 保存模型配置 */
  async function saveModelEdit(): Promise<void> {
    if (!agent || !modelEdit || busy) return;
    setBusy('model');
    setError('');
    try {
      await updateAgent(agent.id, {
        model_id: modelEdit.modelId,
        // M4-T6：表单仅编辑 temperature/max_tokens，其余字段取完整默认，避免契约层缺字段 422
        model_config: {
          ...DEFAULT_MODEL_CONFIG,
          temperature: Number(modelEdit.temperature),
          max_tokens: Number(modelEdit.maxTokens)
        }
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '模型配置保存失败');
    } finally {
      setBusy(null);
    }
  }

  /** 保存工具配置 */
  async function saveToolEdit(): Promise<void> {
    if (!toolEdit || busy) return;
    setBusy(`tool:${toolEdit.toolId}`);
    setError('');
    try {
      await updateTool(toolEdit.toolId, {
        name: toolEdit.name,
        description: toolEdit.description === '' ? null : toolEdit.description,
        enabled: toolEdit.enabled
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '工具配置保存失败');
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <p className="agent-detail__loading" role="status">正在加载 Agent 详情</p>;

  if (!agent) {
    return <main className="agent-detail">
      <div className="agent-detail__topbar">
        <Link to="/agents" className="agent-detail__back">← 返回智能体列表</Link>
      </div>
      {error && <p className="agent-detail__error" role="alert">{error}</p>}
    </main>;
  }

  const toolCount = agent.bound_tool_count ?? tools.length;
  const editingModel = editing === 'model';

  return (
    <main className="agent-detail">
      <div className="agent-detail__topbar">
        <Link to="/agents" className="agent-detail__back">← 返回智能体列表</Link>
      </div>

      {error && <p className="agent-detail__error" role="alert">{error}</p>}

      {/* 基础常规信息 */}
      <section className="agent-detail__header" aria-label="智能体基本信息">
        <div className="agent-detail__title-row">
          <h1 className="agent-detail__title">{agent.name}</h1>
          <span className={`agent-detail__badge ${agent.status === 'active' ? 'agent-detail__badge--enabled' : 'agent-detail__badge--disabled'}`}>
            {statusText(agent.status)}
          </span>
          {agent.is_default && <span className="agent-detail__badge agent-detail__badge--neutral">默认</span>}
        </div>
        {agent.description && <p className="agent-detail__subtitle">{agent.description}</p>}
        <div className="agent-detail__badge-row">
          <span className="agent-detail__badge agent-detail__badge--neutral">{PLATFORM_LABEL[agent.platform]}</span>
          <span className="agent-detail__badge agent-detail__badge--neutral">{agent.model_id}</span>
        </div>
        <div className="agent-detail__grid">
          <div className="agent-detail__field">
            <span className="agent-detail__field-label">创建时间</span>
            <span className="agent-detail__field-value">{formatDate(agent.created_at)}</span>
          </div>
          <div className="agent-detail__field">
            <span className="agent-detail__field-label">最近更新</span>
            <span className="agent-detail__field-value">{formatDate(agent.updated_at)}</span>
          </div>
          <div className="agent-detail__field">
            <span className="agent-detail__field-label">绑定工具</span>
            <span className="agent-detail__field-value">{toolCount} 个</span>
          </div>
        </div>
      </section>

      {/* 模型配置信息（可编辑） */}
      <section className="agent-detail__section" aria-label="模型配置">
        <div className="agent-detail__section-head">
          <h2 className="agent-detail__section-title">模型配置</h2>
          {!editingModel && (
            <button type="button" className="agent-detail__edit-btn" disabled={busy !== null}
              onClick={startModelEdit}>编辑</button>
          )}
        </div>
        {editingModel && modelEdit ? (
          <form className="agent-detail__form" onSubmit={(event) => { event.preventDefault(); void saveModelEdit(); }}>
            <label className="agent-detail__form-field">
              <span className="agent-detail__field-label">模型 ID</span>
              <input type="text" value={modelEdit.modelId}
                onChange={(event) => setModelEdit({ ...modelEdit, modelId: event.target.value })} />
            </label>
            <label className="agent-detail__form-field">
              <span className="agent-detail__field-label">Temperature</span>
              <input type="number" min={0} max={2} step={0.1} value={modelEdit.temperature}
                onChange={(event) => setModelEdit({ ...modelEdit, temperature: event.target.value })} />
            </label>
            <label className="agent-detail__form-field">
              <span className="agent-detail__field-label">Max Tokens</span>
              <input type="number" min={1} max={32768} value={modelEdit.maxTokens}
                onChange={(event) => setModelEdit({ ...modelEdit, maxTokens: event.target.value })} />
            </label>
            <div className="agent-detail__form-actions">
              <button type="submit" disabled={busy !== null}>{busy === 'model' ? '保存中' : '保存'}</button>
              <button type="button" disabled={busy !== null} onClick={cancelEdit}>取消</button>
            </div>
          </form>
        ) : (
          <div className="agent-detail__grid">
            <div className="agent-detail__field">
              <span className="agent-detail__field-label">模型 ID</span>
              <span className="agent-detail__field-value">{agent.model_id}</span>
            </div>
            <div className="agent-detail__field">
              <span className="agent-detail__field-label">Temperature</span>
              <span className="agent-detail__field-value">{agent.model_config.temperature ?? '—'}</span>
            </div>
            <div className="agent-detail__field">
              <span className="agent-detail__field-label">Max Tokens</span>
              <span className="agent-detail__field-value">{agent.model_config.max_tokens ?? '—'}</span>
            </div>
          </div>
        )}
      </section>

      {/* 已绑定工具列表（可编辑） */}
      <section className="agent-detail__section" aria-label="已绑定工具">
        <h2 className="agent-detail__section-title">已绑定工具（{toolCount}）</h2>
        {tools.length === 0
          ? <p className="agent-detail__empty">暂未绑定工具</p>
          : <div className="agent-detail__tools">
              {tools.map((tool) => {
                const editingTool = editing === `tool:${tool.tool_id}`;
                return (
                  <article key={tool.tool_id} className="agent-detail__tool-card">
                    <div className="agent-detail__title-row">
                      <span className="agent-detail__tool-name">{tool.name}</span>
                      <span className={`agent-detail__badge ${tool.enabled ? 'agent-detail__badge--enabled' : 'agent-detail__badge--disabled'}`}>
                        {tool.enabled ? '启用' : '停用'}
                      </span>
                      {!editingTool && (
                        <button type="button" className="agent-detail__edit-btn agent-detail__edit-btn--small"
                          disabled={busy !== null} onClick={() => startToolEdit(tool)}>编辑</button>
                      )}
                    </div>
                    <span className="agent-detail__tool-id">{tool.tool_id}</span>
                    {editingTool && toolEdit ? (
                      <form className="agent-detail__form" onSubmit={(event) => { event.preventDefault(); void saveToolEdit(); }}>
                        <label className="agent-detail__form-field">
                          <span className="agent-detail__field-label">工具名称</span>
                          <input type="text" value={toolEdit.name}
                            onChange={(event) => setToolEdit({ ...toolEdit, name: event.target.value })} />
                        </label>
                        <label className="agent-detail__form-field">
                          <span className="agent-detail__field-label">描述</span>
                          <textarea rows={2} value={toolEdit.description}
                            onChange={(event) => setToolEdit({ ...toolEdit, description: event.target.value })} />
                        </label>
                        <label className="agent-detail__check">
                          <input type="checkbox" checked={toolEdit.enabled}
                            onChange={(event) => setToolEdit({ ...toolEdit, enabled: event.target.checked })} />
                          启用
                        </label>
                        <div className="agent-detail__form-actions">
                          <button type="submit" disabled={busy !== null}>{busy === `tool:${tool.tool_id}` ? '保存中' : '保存'}</button>
                          <button type="button" disabled={busy !== null} onClick={cancelEdit}>取消</button>
                        </div>
                      </form>
                    ) : (
                      tool.description && <p className="agent-detail__tool-desc">{tool.description}</p>
                    )}
                  </article>
                );
              })}
            </div>}
      </section>

      {/* 角色设定（全局 Agent 无作品级角色绑定） */}
      <section className="agent-detail__section" aria-label="角色设定">
        <h2 className="agent-detail__section-title">角色设定</h2>
        <p className="agent-detail__empty">当前智能体为全局配置，暂无作品级角色绑定</p>
      </section>
    </main>
  );
}
