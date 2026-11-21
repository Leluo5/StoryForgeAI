import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AgentsPage } from './agents-page';

// 隔离网络：AgentPanel 内部通过 agent-client 拉取配置，这里让 listAgents 挂起，
// 页面保持加载态即可证明 AgentPanel 已挂载（无需真实数据）。
vi.mock('./agent-client', () => ({
  listAgents: vi.fn(() => new Promise(() => {})),
  listTools: vi.fn(() => new Promise(() => {}))
}));

describe('AgentsPage', () => {
  it('renders the header with title and back link', async () => {
    render(<MemoryRouter initialEntries={['/agents']}><Routes>
      <Route path="/agents" element={<AgentsPage />} />
    </Routes></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '智能体管理' })).toBeVisible();
    expect(screen.getByText('配置创作智能体与工具：模型、温度、令牌上限与工具绑定')).toBeVisible();
    const back = screen.getByRole('link', { name: '返回作品库' });
    expect(back).toHaveAttribute('href', '/works');
  });

  it('mounts the AgentPanel beneath the header', async () => {
    render(<MemoryRouter initialEntries={['/agents']}><Routes>
      <Route path="/agents" element={<AgentsPage />} />
    </Routes></MemoryRouter>);
    // AgentPanel 加载态文本证明其已渲染
    expect(await screen.findByText('正在加载 Agent 配置')).toBeVisible();
  });
});
