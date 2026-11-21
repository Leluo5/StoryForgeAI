import type { JSX } from 'react';
import './admin-page.css';

/**
 * 后台管理占位页（/admin）。
 * 功能尚未实现：先立路由与入口，页面仅展示「开发中」占位说明，后续在此承载后台管理与系统配置。
 */
export function AdminPage(): JSX.Element {
  return <main className="admin-page">
    <div className="admin-page__header">
      <h1 className="admin-page__title">后台</h1>
      <p className="admin-page__subtitle">系统后台管理：账号、权限、审计与运维配置</p>
    </div>
    <div className="admin-page__body">
      <p className="admin-page__placeholder" role="status">后台管理功能开发中，敬请期待。</p>
    </div>
  </main>;
}
