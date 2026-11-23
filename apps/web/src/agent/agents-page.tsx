import type { JSX } from 'react';
import { AgentPanel } from './agent-panel';
import './agents-page.css';

/**
 * 智能体管理独立页（/agents）。
 * 智能体配置为全局作用域（不按作品），故单独承载完整 Agent/工具配置；
 * 入口收口到左侧共享导航工具栏。
 */
export function AgentsPage(): JSX.Element {
  return <main className="agents-page">
    <div className="agents-page__header">
      <div>
        <h1 className="agents-page__title">智能体管理</h1>
        <p className="agents-page__subtitle">配置创作智能体与工具：模型、温度、令牌上限与工具绑定</p>
      </div>
    </div>
    <div className="agents-page__body">
      <AgentPanel />
    </div>
  </main>;
}
