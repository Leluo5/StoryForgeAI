import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { SessionResponse } from '@storyforge/contracts';
import { AuthPage } from './auth/auth-page';
import { getSession, login, logout } from './auth/auth-client';

// 路由级懒加载：作品库与工作台（含 ProseMirror 编辑器、剧情画布）按需加载，
// 未登录时只需下载登录页所需代码。
const WorksPage = lazy(() => import('./works/works-page').then((mod) => ({ default: mod.WorksPage })));
const WorkbenchRoute = lazy(() => import('./workbench/workbench-page').then((mod) => ({ default: mod.WorkbenchRoute })));

export function App() {
  const [session, setSession] = useState<SessionResponse>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    getSession().then(setSession).catch(() => setSession(undefined)).finally(() => setLoading(false));
  }, []);
  if (loading) return <p role="status">正在恢复会话</p>;
  return <BrowserRouter>
    {session ? <>
      <header className="app-session">
        <span>{session.author.display_name}</span>
        <button type="button" onClick={() => { void logout().then(() => setSession(undefined)); }}>退出登录</button>
      </header>
      <Routes>
        <Route path="/" element={<Navigate to="/works" replace />} />
        <Route path="/login" element={<Navigate to="/works" replace />} />
        <Route path="/works" element={<Suspense fallback={<p role="status">正在加载作品库</p>}><WorksPage /></Suspense>} />
        <Route path="/works/:workId/write/:chapterId" element={<Suspense fallback={<p role="status">正在加载工作台</p>}><WorkbenchRoute /></Suspense>} />
        <Route path="*" element={<Navigate to="/works" replace />} />
      </Routes>
    </> : <Routes>
      <Route path="/login" element={<AuthPage login={login} onSuccess={setSession} />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>}
  </BrowserRouter>;
}
