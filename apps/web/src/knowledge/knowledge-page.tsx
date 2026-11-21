import type { JSX } from 'react';
import { KnowledgePanel } from './knowledge-panel';
import './knowledge-page.css';

/**
 * 知识库独立页（/knowledge）。
 * 知识库为全局作用域（按作者归属，不按作品），故单独承载完整录入/检索/导入导出；
 * 入口收口到左侧共享导航工具栏（作品库/知识库/智能体/工作流/模型/后台）。
 */
export function KnowledgePage(): JSX.Element {
  return <main className="knowledge-page">
    <div className="knowledge-page__header">
      <div>
        <h1 className="knowledge-page__title">知识库</h1>
        <p className="knowledge-page__subtitle">集中管理你的资料：录入、检索与 Markdown 导入导出</p>
      </div>
    </div>
    <div className="knowledge-page__body">
      <KnowledgePanel />
    </div>
  </main>;
}
