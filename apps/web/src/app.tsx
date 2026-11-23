import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { applyTheme, initialTheme, type Theme } from '@storyforge/design-tokens';
import type { SessionResponse } from '@storyforge/contracts';
import { AuthPage } from './auth/auth-page';
import { getSession, loginOrRegister, logout } from './auth/auth-client';
import { ModuleLayout } from './layout/module-layout';
import { NotificationCenter } from './revision/notification-center';
import { unreadCount } from './revision/collab-client';
import './app.css';

// 路由级懒加载：作品库与工作台（含 ProseMirror 编辑器、剧情画布）按需加载，
// 未登录时只需下载登录页所需代码。
const WorksPage = lazy(() => import('./works/works-page').then((mod) => ({ default: mod.WorksPage })));
const WorkbenchRoute = lazy(() => import('./workbench/workbench-page').then((mod) => ({ default: mod.WorkbenchRoute })));
const ArkClawPage = lazy(() => import('./arkclaw/arkclaw-page').then((mod) => ({ default: mod.ArkClawPage })));
const KnowledgePage = lazy(() => import('./knowledge/knowledge-page').then((mod) => ({ default: mod.KnowledgePage })));
const AgentsPage = lazy(() => import('./agent/agents-page').then((mod) => ({ default: mod.AgentsPage })));
const WorkflowsPage = lazy(() => import('./agent/workflows-page').then((mod) => ({ default: mod.WorkflowsPage })));
const ModelsPage = lazy(() => import('./agent/models-page').then((mod) => ({ default: mod.ModelsPage })));
const AdminPage = lazy(() => import('./agent/admin-page').then((mod) => ({ default: mod.AdminPage })));

export function App() {
  const [session, setSession] = useState<SessionResponse>();
  const [loading, setLoading] = useState(true);
  // 全局主题（原工作台 header 主题切换按钮迁至此处，改纯图标展示）
  const [theme, setTheme] = useState<Theme>(initialTheme);
  // 通知未读数（用户栏铃铛角标）；通知中心打开时由 NotificationCenter 自身刷新，这里仅作入口角标
  const [noticeUnread, setNoticeUnread] = useState(0);
  const noticeDialog = useRef<HTMLDialogElement>(null);
  // 打开通知中心时递增 key，强制 NotificationCenter 重新挂载（其内部 useEffect 重新拉取最新数据）
  const [noticeOpenKey, setNoticeOpenKey] = useState(0);

  useEffect(() => {
    getSession().then(setSession).catch(() => setSession(undefined)).finally(() => setLoading(false));
  }, []);
  // 用户栏铃铛角标：登录后拉取未读数；通知中心打开时由 NotificationCenter 自身刷新
  useEffect(() => {
    if (!session) return;
    let active = true;
    void unreadCount().then((count) => { if (active) setNoticeUnread(count.unread); }).catch(() => {});
    return () => { active = false; };
  }, [session]);

  function toggleTheme(): void {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    applyTheme(next);
  }
  function openNotice(): void {
    // 每次打开刷新角标，并强制通知中心重新拉取最新通知
    void unreadCount().then((count) => setNoticeUnread(count.unread)).catch(() => {});
    setNoticeOpenKey((key) => key + 1);
    noticeDialog.current?.showModal();
  }
  function closeNotice(): void {
    noticeDialog.current?.close();
  }

  if (loading) return <p role="status">正在恢复会话</p>;
  // 未登录：仅 /login 渲染登录页，其余路径统一重定向到 /login（保持 URL 与登录态一致）
  if (!session) return <BrowserRouter>
    <Routes>
      <Route path="/login" element={<AuthPage login={loginOrRegister} onSuccess={setSession} />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  </BrowserRouter>;
  return <BrowserRouter>
    <header className="app-session">
      {/* 用户栏：用户名（最左）→ 主题切换 / 通知 纯图标 → 退出登录 */}
      <span>{session.author.display_name}</span>
      <button type="button" className="app-icon-button" onClick={toggleTheme} aria-label={theme === 'light' ? '切换深色主题' : '切换浅色主题'} title={theme === 'light' ? '切换深色主题' : '切换浅色主题'}>
        {/* 太阳/月亮纯图标，移除文字标签 */}
        {theme === 'light' ? (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
          </svg>
        )}
      </button>
      <button type="button" className="app-icon-button" onClick={openNotice} aria-label={`通知（${noticeUnread} 条未读）`} title={`通知（${noticeUnread} 条未读）`}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {noticeUnread > 0 && <span className="app-notice-badge" aria-hidden="true">{noticeUnread > 99 ? '99+' : noticeUnread}</span>}
      </button>
      <button type="button" onClick={() => { void logout().then(() => setSession(undefined)); }}>退出登录</button>
    </header>
    <dialog ref={noticeDialog} className="app-notice-dialog" aria-labelledby="app-notice-title">
      <header className="app-notice-head">
        <h2 id="app-notice-title">通知中心</h2>
        <button type="button" onClick={closeNotice}>关闭通知</button>
      </header>
      <NotificationCenter key={noticeOpenKey} />
    </dialog>
    <Routes>
      <Route path="/" element={<Navigate to="/works" replace />} />
      <Route path="/login" element={<Navigate to="/works" replace />} />
      {/* 功能模块壳：左侧共享导航工具栏 + 右侧模块内容，七个路由共用同一布局 */}
      <Route element={<ModuleLayout />}>
        <Route path="/works" element={<Suspense fallback={<p role="status">正在加载作品库</p>}><WorksPage /></Suspense>} />
        <Route path="/knowledge" element={<Suspense fallback={<p role="status">正在加载知识库</p>}><KnowledgePage /></Suspense>} />
        <Route path="/agents" element={<Suspense fallback={<p role="status">正在加载智能体管理</p>}><AgentsPage /></Suspense>} />
        <Route path="/workflows" element={<Suspense fallback={<p role="status">正在加载工作流管理</p>}><WorkflowsPage /></Suspense>} />
        <Route path="/models" element={<Suspense fallback={<p role="status">正在加载模型</p>}><ModelsPage /></Suspense>} />
        <Route path="/admin" element={<Suspense fallback={<p role="status">正在加载后台</p>}><AdminPage /></Suspense>} />
        {/* 写作工作台：纳入共享壳，常驻左侧侧边栏；「作品库」入口保持高亮（NavLink 子路径自动激活） */}
        <Route path="/works/:workId/write/:chapterId" element={<Suspense fallback={<p role="status">正在加载工作台</p>}><WorkbenchRoute /></Suspense>} />
      </Route>
      {/* ArkClaw 验证页：main 演进功能，独立于模块壳 */}
      <Route path="/arkclaw" element={<Suspense fallback={<p role="status">正在加载 ArkClaw 验证页</p>}><ArkClawPage /></Suspense>} />
      <Route path="*" element={<Navigate to="/works" replace />} />
    </Routes>
  </BrowserRouter>;
}
