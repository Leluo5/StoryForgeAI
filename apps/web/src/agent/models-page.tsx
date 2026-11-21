import type { JSX } from 'react';
import './models-page.css';

/**
 * 模型管理占位页（/models）。
 * 功能尚未实现：先立路由与入口，页面仅展示「开发中」占位说明，后续在此承载模型管理与配置。
 */
export function ModelsPage(): JSX.Element {
  return <main className="models-page">
    <div className="models-page__header">
      <h1 className="models-page__title">模型</h1>
      <p className="models-page__subtitle">配置与管理 AI 模型：接入、参数与调用策略</p>
    </div>
    <div className="models-page__body">
      <p className="models-page__placeholder" role="status">模型管理功能开发中，敬请期待。</p>
    </div>
  </main>;
}
