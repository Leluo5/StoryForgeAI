import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { Agent, AgentListItem, AiToolListItem, AgentPlatform } from '@storyforge/contracts';
import {
  createAgent, deleteAgent, listAgents, listTools, updateAgent, updateTool
} from './agent-client';
import './agent-panel.css';

const PLATFORM_LABEL: Record<AgentPlatform, string> = {
  mock: 'Mock（内置）',
  coze: 'Coze（预留）',
  flowise: 'Flowise（自建）'
};

/** 工具配置表单编辑状态 */
interface ToolEdit {
  toolId: string;
  agentId: string; // '' = 未绑定
  name: string;
  enabled: boolean;
}

/** 新增/编辑 Agent 表单状态 */
interface AgentForm {
  id: string | null; // null=新增
  name: string;
  modelId: string;
  temperature: string;
  maxTokens: string;
  isDefault: boolean;
}

const EMPTY_AGENT_FORM: AgentForm = { id: null, name: '', modelId: '', temperature: '0.7', maxTokens: '2048', isDefault: false };

function statusText(status: Agent['status']): string {
  return status === 'active' ? '启用' : '停用';
}

export function AgentPanel(): JSX.Element {
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [tools, setTools] = useState<AiToolListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [toolEdit, setToolEdit] = useState<ToolEdit | null>(null);
  const [agentForm, setAgentForm] = useState<AgentForm>(EMPTY_AGENT_FORM);
  const [editingTool, setEditingTool] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, t] = await Promise.all([listAgents(), listTools()]);
      setAgents(a.agents);
      setTools(t.tools);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Agent 配置加载失败');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Agent 表单与工具编辑的选中项随数据刷新同步（避免引用陈旧）
  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const toolsById = useMemo(() => new Map(tools.map((t) => [t.tool_id, t])), [tools]);

  async function submitToolEdit(): Promise<void> {
    if (!toolEdit || busy) return;
    setBusy(`tool:${toolEdit.toolId}`);
    setError('');
    try {
      await updateTool(toolEdit.toolId, {
        name: toolEdit.name,
        agent_id: toolEdit.agentId === '' ? null : toolEdit.agentId,
        enabled: toolEdit.enabled
      });
      setToolEdit(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '工具配置保存失败');
    } finally {
      setBusy(null);
    }
  }

  async function submitAgentForm(): Promise<void> {
    if (busy) return;
    setBusy('agent-form');
    setError('');
    try {
      const model_config = {
        temperature: Number(agentForm.temperature),
        max_tokens: Number(agentForm.maxTokens)
      };
      if (agentForm.id) {
        await updateAgent(agentForm.id, {
          name: agentForm.name,
          model_id: agentForm.modelId,
          model_config,
          is_default: agentForm.isDefault
        });
      } else {
        await createAgent({
          name: agentForm.name,
          platform: 'mock',
          model_id: agentForm.modelId,
          model_config,
          is_default: agentForm.isDefault
        });
      }
      setAgentForm(EMPTY_AGENT_FORM);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Agent 保存失败');
    } finally {
      setBusy(null);
    }
  }

  async function toggleAgentDefault(agent: AgentListItem): Promise<void> {
    if (agent.is_default || busy) return;
    setBusy(`default:${agent.id}`);
    setError('');
    try {
      await updateAgent(agent.id, { is_default: true });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '设置默认失败');
    } finally {
      setBusy(null);
    }
  }

  async function removeAgent(agent: AgentListItem): Promise<void> {
    if (agent.is_default || busy) return;
    setBusy(`delete:${agent.id}`);
    setError('');
    try {
      await deleteAgent(agent.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      setBusy(null);
    }
  }

  function renderTool(tool: AiToolListItem): JSX.Element {
    const editing = editingTool && toolEdit?.toolId === tool.tool_id;
    return <section key={tool.tool_id} className="agent-tool-card" aria-label={`工具 ${tool.name}`}>
      <header className="agent-tool-head">
        <span className="agent-tool-name">{tool.name}</span>
        <span className="agent-tool-id">{tool.tool_id}</span>
        <span className={`agent-badge ${tool.enabled ? 'agent-badge-enabled' : 'agent-badge-disabled'}`}>
          {tool.enabled ? '启用' : '停用'}
        </span>
        <div className="agent-tool-actions">
          <button type="button" disabled={busy !== null}
            onClick={() => { setToolEdit({ toolId: tool.tool_id, agentId: tool.agent_id ?? '', name: tool.name, enabled: tool.enabled }); setEditingTool(true); }}>
            配置
          </button>
        </div>
      </header>
      <p className="agent-tool-meta">
        {tool.bound_agent
          ? <span className="agent-bound">绑定 Agent：{tool.bound_agent.name}</span>
          : <span className="agent-bound-empty">未绑定 Agent（将使用默认 Agent）</span>}
      </p>
      {editing && toolEdit && (
        <form className="agent-form" onSubmit={(event) => { event.preventDefault(); void submitToolEdit(); }}>
          <label htmlFor={`tool-name-${tool.tool_id}`}>工具名称</label>
          <input id={`tool-name-${tool.tool_id}`} type="text" value={toolEdit.name}
            onChange={(event) => setToolEdit({ ...toolEdit, name: event.target.value })} />
          <label htmlFor={`tool-agent-${tool.tool_id}`}>绑定 Agent</label>
          <select id={`tool-agent-${tool.tool_id}`} value={toolEdit.agentId}
            onChange={(event) => setToolEdit({ ...toolEdit, agentId: event.target.value })}>
            <option value="">未绑定（使用默认 Agent）</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.is_default ? '（默认）' : ''}</option>)}
          </select>
          <label className="agent-check">
            <input type="checkbox" checked={toolEdit.enabled}
              onChange={(event) => setToolEdit({ ...toolEdit, enabled: event.target.checked })} />
            启用
          </label>
          <div className="agent-form-actions">
            <button type="submit" disabled={busy !== null}>{busy === `tool:${tool.tool_id}` ? '保存中' : '保存'}</button>
            <button type="button" disabled={busy !== null} onClick={() => { setEditingTool(false); setToolEdit(null); }}>取消</button>
          </div>
        </form>
      )}
    </section>;
  }

  function renderAgent(agent: AgentListItem): JSX.Element {
    return <section key={agent.id} className="agent-card" aria-label={`Agent ${agent.name}`}>
      <header className="agent-card-head">
        <span className="agent-card-name">{agent.name}</span>
        {agent.is_default && <span className="agent-default-tag">默认</span>}
        <span className={`agent-badge ${agent.status === 'active' ? 'agent-badge-enabled' : 'agent-badge-disabled'}`}>
          {statusText(agent.status)}
        </span>
      </header>
      <p className="agent-card-meta">
        {PLATFORM_LABEL[agent.platform]} · {agent.model_id} · 绑定 {agent.bound_tool_count} 个工具
      </p>
      <div className="agent-card-actions">
        <button type="button" disabled={busy !== null}
          onClick={() => setAgentForm({ id: agent.id, name: agent.name, modelId: agent.model_id, temperature: String(agent.model_config.temperature ?? 0.7), maxTokens: String(agent.model_config.max_tokens ?? 2048), isDefault: agent.is_default })}>
          编辑
        </button>
        {!agent.is_default && (
          <button type="button" disabled={busy !== null} onClick={() => void toggleAgentDefault(agent)}>
            {busy === `default:${agent.id}` ? '设置中' : '设为默认'}
          </button>
        )}
        {!agent.is_default && (
          <button type="button" disabled={busy !== null} onClick={() => void removeAgent(agent)}>
            {busy === `delete:${agent.id}` ? '删除中' : '删除'}
          </button>
        )}
      </div>
    </section>;
  }

  if (loading) return <p className="agent-loading" role="status">正在加载 Agent 配置</p>;
  return <div className="agent-panel">
    <h2>Agent 管理</h2>
    {error && <p className="agent-error" role="alert">{error}</p>}

    <h3>创作工具</h3>
    <div className="agent-tools">
      {tools.map(renderTool)}
    </div>

    <h3>{agentForm.id ? '编辑 Agent' : '新增 Agent'}</h3>
    <form className="agent-form" onSubmit={(event) => { event.preventDefault(); void submitAgentForm(); }}>
      <label htmlFor="agent-name">名称</label>
      <input id="agent-name" type="text" value={agentForm.name}
        onChange={(event) => setAgentForm({ ...agentForm, name: event.target.value })} />
      <label htmlFor="agent-model">模型 ID</label>
      <input id="agent-model" type="text" value={agentForm.modelId}
        onChange={(event) => setAgentForm({ ...agentForm, modelId: event.target.value })} />
      <div className="agent-form-row">
        <div>
          <label htmlFor="agent-temp">Temperature</label>
          <input id="agent-temp" type="number" min={0} max={2} step={0.1} value={agentForm.temperature}
            onChange={(event) => setAgentForm({ ...agentForm, temperature: event.target.value })} />
        </div>
        <div>
          <label htmlFor="agent-max">Max Tokens</label>
          <input id="agent-max" type="number" min={1} max={32768} value={agentForm.maxTokens}
            onChange={(event) => setAgentForm({ ...agentForm, maxTokens: event.target.value })} />
        </div>
      </div>
      <label className="agent-check">
        <input type="checkbox" checked={agentForm.isDefault}
          onChange={(event) => setAgentForm({ ...agentForm, isDefault: event.target.checked })} />
        设为默认 Agent
      </label>
      <div className="agent-form-actions">
        <button type="submit" disabled={busy !== null}>{busy === 'agent-form' ? '保存中' : '保存'}</button>
        {agentForm.id && (
          <button type="button" disabled={busy !== null} onClick={() => setAgentForm(EMPTY_AGENT_FORM)}>取消编辑</button>
        )}
      </div>
    </form>

    <h3>Agent 列表</h3>
    {agents.length === 0
      ? <p className="agent-empty">暂无 Agent</p>
      : <div className="agent-cards">{agents.map(renderAgent)}</div>}
  </div>;
}
