import { Link } from 'react-router-dom';
import type { JSX } from 'react';
import { Button } from '@storyforge/ui';
import { KnowledgePanel } from './knowledge-panel';
import './knowledge-page.css';

/**
 * 知识库独立页（/knowledge）。
 * 知识库为全局作用域（按作者归属，不按作品），故单独承载完整录入/检索/导入导出，
 * 与作品库页头入口跳转对应；工作台右侧 tab 已移除，入口唯一收口到作品库页头。
 */
export function KnowledgePage(): JSX.Element {
  return <main className="knowledge-page">
    <div className="knowledge-page__header">
      <div>
        <h1 className="knowledge-page__title">知识库</h1>
        <p className="knowledge-page__subtitle">集中管理你的资料：录入、检索与 Markdown 导入导出</p>
      </div>
      <Link to="/works"><Button variant="secondary">返回作品库</Button></Link>
    </div>
    <div className="knowledge-page__body">
      <KnowledgePanel />
    </div>
  </main>;
}