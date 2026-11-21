import { Link } from 'react-router-dom';
import type { JSX } from 'react';
import { Button } from '@storyforge/ui';
import './workflows-page.css';

/**
 * 工作流管理占位页（/workflows）。
 * 功能尚未实现：先立路由与入口，页面仅展示「开发中」占位说明，后续在此承载工作流编排。
 */
export function WorkflowsPage(): JSX.Element {
  return <main className="workflows-page">
    <div className="workflows-page__header">
      <div>
        <h1 className="workflows-page__title">工作流管理</h1>
        <p className="workflows-page__subtitle">编排创作工作流：自动化流程与规则配置</p>
      </div>
      <Link to="/works"><Button variant="secondary">返回作品库</Button></Link>
    </div>
    <div className="workflows-page__body">
      <p className="workflows-page__placeholder" role="status">工作流管理功能开发中，敬请期待。</p>
    </div>
  </main>;
}
