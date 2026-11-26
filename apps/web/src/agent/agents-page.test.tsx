import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { AgentListItem } from '@storyforge/contracts';
import { AgentsPage } from './agents-page';
import { listAgents } from './agent-client';

vi.mock('./agent-client', () => ({
  listAgents: vi.fn(),
  getAgentDetail: vi.fn()
}));

const baseAgent: AgentListItem = {
  id: 'agent-1',
  author_id: 'author-1',
  name: '灵感助手',
  platform: 'mock',
  platform_config: {},
  model_id: 'gpt-4o-mini',
  model_config: { temperature: 0.7, top_p: 1.0, max_tokens: 4096, system_prompt: '', stream: false, frequency_penalty: 0, presence_penalty: 0, response_format: 'text', stop: [] },
  status: 'active',
  is_default: false,
  description: '用于章节灵感与续写的助手',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  bound_tool_count: 2
};

function renderPage(entries: string[] = ['/agents']) {
  return render(<MemoryRouter initialEntries={entries}><Routes>
    <Route path="/agents" element={<AgentsPage />} />
    <Route path="/agents/:agentId" element={<p>详情占位</p>} />
  </Routes></MemoryRouter>);
}

describe('AgentsPage', () => {
  it('renders the header with title and subtitle', () => {
    vi.mocked(listAgents).mockResolvedValue({ agents: [] });
    renderPage();
    expect(screen.getByRole('heading', { name: '智能体管理' })).toBeVisible();
    expect(screen.getByText('配置创作智能体与工具：模型、温度、令牌上限与工具绑定')).toBeVisible();
  });

  it('renders a card per agent with name, description and platform', async () => {
    vi.mocked(listAgents).mockResolvedValue({ agents: [baseAgent] });
    renderPage();
    expect(await screen.findByText('灵感助手')).toBeVisible();
    expect(screen.getByText('用于章节灵感与续写的助手')).toBeVisible();
    expect(screen.getByText('Mock（内置）')).toBeVisible();
    expect(screen.getByText('gpt-4o-mini')).toBeVisible();
    expect(screen.getByText('2 个工具')).toBeVisible();
    expect(screen.getByText('启用')).toBeVisible();
  });

  it('shows a placeholder description when absent', async () => {
    vi.mocked(listAgents).mockResolvedValue({ agents: [{ ...baseAgent, description: '' }] });
    renderPage();
    expect(await screen.findByText('暂无功能描述')).toBeVisible();
  });

  it('navigates to the agent detail route on card click', async () => {
    vi.mocked(listAgents).mockResolvedValue({ agents: [baseAgent] });
    renderPage();
    const card = await screen.findByRole('button', { name: /查看智能体 灵感助手 详情/ });
    await userEvent.click(card);
    expect(await screen.findByText('详情占位')).toBeVisible();
  });

  it('renders an empty state when no agents exist', async () => {
    vi.mocked(listAgents).mockResolvedValue({ agents: [] });
    renderPage();
    expect(await screen.findByText('暂无智能体，请先在智能体配置中创建')).toBeVisible();
  });

  it('surfaces a load error', async () => {
    vi.mocked(listAgents).mockRejectedValue(new Error('网络错误'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('网络错误');
  });
});
