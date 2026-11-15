import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { SessionResponse } from '@storyforge/contracts';
import { AuthPage } from './auth/auth-page';
import { getSession, login } from './auth/auth-client';
import { WorksPage } from './works/works-page';

export function App() {
  const [session, setSession] = useState<SessionResponse>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    getSession().then(setSession).catch(() => setSession(undefined)).finally(() => setLoading(false));
  }, []);
  if (loading) return <p role="status">正在恢复会话</p>;
  if (!session) return <AuthPage login={login} onSuccess={setSession} />;
  return <BrowserRouter><Routes>
    <Route path="/" element={<Navigate to="/works" replace />} />
    <Route path="/works" element={<WorksPage />} />
    <Route path="*" element={<Navigate to="/works" replace />} />
  </Routes></BrowserRouter>;
}
