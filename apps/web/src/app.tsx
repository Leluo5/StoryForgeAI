import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { SessionResponse } from '@storyforge/contracts';
import { AuthPage } from './auth/auth-page';
import { getSession, loginOrRegister, logout } from './auth/auth-client';
import { ModuleLayout } from './layout/module-layout';

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
  useEffect(() => {
    getSession().then(setSession).catch(() => setSession(undefined)).finally(() => setLoading(false));
  }, []);
  if (loading) return <p role="status">正在恢复会话</p>;
  if (!session) return <AuthPage login={loginOrRegister} onSuccess={setSession} />;
  return <BrowserRouter>
    <header className="app-session">
      <span>{session.author.display_name}</span>
      <button type="button" onClick={() => { void logout().then(() => setSession(undefined)); }}>退出登录</button>
    </header>
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
