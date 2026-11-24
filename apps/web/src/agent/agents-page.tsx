import { useCallback, useEffect, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AgentListItem, AgentPlatform } from '@storyforge/contracts';
import { listAgents } from './agent-client';
import './agents-page.css';

const PLATFORM_LABEL: Record<AgentPlatform, string> = {
  mock: 'Mock（内置）',
  coze: 'Coze（预留）',
  flowise: 'Flowise（自建）'
};

function statusText(status: AgentListItem['status']): string {
  return status === 'active' ? '启用' : '停用';
}

/**
 * 智能体管理总览页（/agents）。
 * 卡片式布局展示所有智能体（名称/功能描述/所属平台），点击卡片跳转对应详情页。
 * 智能体配置为全局作用域（不按作品），配置编辑入口收口到左侧共享导航工具栏。
 */
export function AgentsPage(): JSX.Element {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await listAgents();
      setAgents(res.agents);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '智能体加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <main className="agents-page">
      <div className="agents-page__header">
        <div>
          <h1 className="agents-page__title">智能体管理</h1>
          <p className="agents-page__subtitle">配置创作智能体与工具：模型、温度、令牌上限与工具绑定</p>
        </div>
      </div>

      {loading && <p className="agents-page__loading" role="status">正在加载智能体</p>}
      {error && <p className="agents-page__error" role="alert">{error}</p>}

      {!loading && !error && (
        agents.length === 0
          ? <p className="agents-page__empty">暂无智能体，请先在智能体配置中创建</p>
          : <div className="agents-page__cards">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  className="agent-overview-card"
                  onClick={() => navigate(`/agents/${agent.id}`)}
                  aria-label={`查看智能体 ${agent.name} 详情`}
                >
                  <div className="agent-overview-card__head">
                    <span className="agent-overview-card__name">{agent.name}</span>
                    <span className={`agent-overview-card__badge ${agent.status === 'active' ? 'agent-overview-card__badge--enabled' : 'agent-overview-card__badge--disabled'}`}>
                      {statusText(agent.status)}
                    </span>
                  </div>
                  <p className="agent-overview-card__desc">
                    {agent.description || '暂无功能描述'}
                  </p>
                  <div className="agent-overview-card__foot">
                    <span className="agent-overview-card__meta">{PLATFORM_LABEL[agent.platform]}</span>
                    <span className="agent-overview-card__meta">{agent.model_id}</span>
                    <span className="agent-overview-card__meta">{agent.bound_tool_count} 个工具</span>
                    {agent.is_default && <span className="agent-overview-card__default">默认</span>}
                  </div>
                </button>
              ))}
            </div>
      )}
    </main>
  );
}
