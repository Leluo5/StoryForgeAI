import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { AgentListItem, AiToolListItem } from '@storyforge/contracts';
import { AgentDetailPage } from './agent-detail-page';
import { getAgentDetail, updateAgent, updateTool } from './agent-client';

vi.mock('./agent-client', () => ({
  getAgentDetail: vi.fn(),
  updateAgent: vi.fn(),
  updateTool: vi.fn(),
  DEFAULT_MODEL_CONFIG: {
    temperature: 0.7, top_p: 1.0, max_tokens: 2048, system_prompt: '',
    stream: false, frequency_penalty: 0, presence_penalty: 0,
    response_format: 'text', stop: []
  }
}));

const detailFixture: { agent: AgentListItem; tools: AiToolListItem[] } = {
  agent: {
    id: 'agent-1', author_id: 'a1', name: '灵感助手', platform: 'mock', platform_config: {},
    model_id: 'gpt-4o-mini', model_config: { temperature: 0.7, top_p: 1.0, max_tokens: 4096, system_prompt: '', stream: false, frequency_penalty: 0, presence_penalty: 0, response_format: 'text', stop: [] },
    status: 'active', is_default: true, description: '章节续写助手',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
    bound_tool_count: 1
  },
  tools: [{
    id: 'tool-1', tool_id: 'continue', name: '续写', description: '在章节末尾继续推进情节',
    agent_id: 'agent-1', enabled: true,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    bound_agent: { id: 'agent-1', name: '灵感助手', platform: 'mock', model_id: 'gpt-4o-mini', status: 'active' }
  }]
};

function renderDetail(agentId = 'agent-1') {
  return render(<MemoryRouter initialEntries={[`/agents/${agentId}`]}><Routes>
    <Route path="/agents/:agentId" element={<AgentDetailPage />} />
    <Route path="/agents" element={<p>列表占位</p>} />
  </Routes></MemoryRouter>);
}

describe('AgentDetailPage', () => {
  it('renders basic info, model config and bound tools', async () => {
    vi.mocked(getAgentDetail).mockResolvedValue(detailFixture);
    renderDetail();
    expect(await screen.findByRole('heading', { name: '灵感助手' })).toBeVisible();
    expect(screen.getByText('章节续写助手')).toBeVisible();
    // 模型 ID 在 header 徽章行与模型配置区块各渲染一次
    expect(screen.getAllByText('gpt-4o-mini')).toHaveLength(2);
    expect(screen.getByText('Mock（内置）')).toBeVisible();
    expect(screen.getByText('默认')).toBeVisible();
    // 模型配置区块
    expect(screen.getByText('模型配置')).toBeVisible();
    expect(screen.getByText('0.7')).toBeVisible();
    expect(screen.getByText('4096')).toBeVisible();
    // 绑定工具区块
    expect(screen.getByText('已绑定工具（1）')).toBeVisible();
    expect(screen.getByText('续写')).toBeVisible();
    expect(screen.getByText('在章节末尾继续推进情节')).toBeVisible();
    // 角色设定占位
    expect(screen.getByText('角色设定')).toBeVisible();
    expect(screen.getByText('当前智能体为全局配置，暂无作品级角色绑定')).toBeVisible();
  });

  it('shows an empty state for tools when none bound', async () => {
    vi.mocked(getAgentDetail).mockResolvedValue({
      agent: {
        id: 'agent-1', author_id: 'a1', name: '无绑定', platform: 'flowise', platform_config: {},
        model_id: 'm1', model_config: { temperature: 0.7, top_p: 1.0, max_tokens: 2048, system_prompt: '', stream: false, frequency_penalty: 0, presence_penalty: 0, response_format: 'text', stop: [] }, status: 'disabled', is_default: false,
        description: '', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
        bound_tool_count: 0
      },
      tools: []
    });
    renderDetail();
    expect(await screen.findByText('暂未绑定工具')).toBeVisible();
    // 无描述则不渲染 subtitle
    expect(screen.queryByText('暂无功能描述')).toBeNull();
    expect(screen.getByText('停用')).toBeVisible();
  });

  it('navigates back to the agent list', async () => {
    vi.mocked(getAgentDetail).mockResolvedValue({
      agent: {
        id: 'agent-1', author_id: 'a1', name: '返回', platform: 'mock', platform_config: {},
        model_id: 'm1', model_config: { temperature: 0.7, top_p: 1.0, max_tokens: 2048, system_prompt: '', stream: false, frequency_penalty: 0, presence_penalty: 0, response_format: 'text', stop: [] }, status: 'active', is_default: false,
        description: '', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
        bound_tool_count: 0
      },
      tools: []
    });
    renderDetail();
    await userEvent.click(await screen.findByRole('link', { name: /返回智能体列表/ }));
    expect(await screen.findByText('列表占位')).toBeVisible();
  });

  it('surfaces a load error', async () => {
    vi.mocked(getAgentDetail).mockRejectedValue(new Error('Agent 详情加载失败'));
    renderDetail();
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent 详情加载失败');
  });

  it('edits model config and saves via updateAgent', async () => {
    vi.mocked(getAgentDetail).mockResolvedValue(detailFixture);
    vi.mocked(updateAgent).mockResolvedValue({ agent: detailFixture.agent });
    renderDetail();
    // 打开模型配置编辑（模型配置区首个「编辑」按钮）
    await userEvent.click((await screen.findAllByRole('button', { name: '编辑' }))[0]!);
    // 修改模型 ID 与温度
    const modelInput = await screen.findByLabelText(/模型 ID/);
    await userEvent.clear(modelInput);
    await userEvent.type(modelInput, 'gpt-4o');
    const tempInput = screen.getByLabelText(/Temperature/);
    await userEvent.clear(tempInput);
    await userEvent.type(tempInput, '0.5');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(updateAgent).toHaveBeenCalledWith('agent-1', {
      model_id: 'gpt-4o',
      model_config: { temperature: 0.5, top_p: 1.0, max_tokens: 4096, system_prompt: '', stream: false, frequency_penalty: 0, presence_penalty: 0, response_format: 'text', stop: [] }
    }));
    // 保存后刷新详情
    expect(getAgentDetail).toHaveBeenCalledTimes(2);
  });

  it('cancels model edit without saving', async () => {
    vi.mocked(getAgentDetail).mockResolvedValue(detailFixture);
    renderDetail();
    await userEvent.click((await screen.findAllByRole('button', { name: '编辑' }))[0]!);
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(updateAgent).not.toHaveBeenCalled();
    // 取消后模型 ID 在 header 徽章与模型配置字段各显示一次
    expect(screen.getAllByText('gpt-4o-mini')).toHaveLength(2);
  });

  it('edits a tool and saves via updateTool', async () => {
    vi.mocked(getAgentDetail).mockResolvedValue(detailFixture);
    vi.mocked(updateTool).mockResolvedValue({ tool: detailFixture.tools[0]!, warning: null });
    renderDetail();
    // 工具卡编辑按钮（工具名旁的「编辑」，模型配置区也有一处「编辑」，取最后一个）
    const editButtons = await screen.findAllByRole('button', { name: '编辑' });
    await userEvent.click(editButtons[editButtons.length - 1]!);
    const nameInput = await screen.findByLabelText(/工具名称/);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, '智能续写');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(updateTool).toHaveBeenCalledWith('continue', {
      name: '智能续写',
      description: '在章节末尾继续推进情节',
      enabled: true
    }));
  });

  it('surfaces an edit error without crashing', async () => {
    vi.mocked(getAgentDetail).mockResolvedValue(detailFixture);
    vi.mocked(updateAgent).mockRejectedValue(new Error('模型配置保存失败'));
    renderDetail();
    await userEvent.click((await screen.findAllByRole('button', { name: '编辑' }))[0]!);
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('模型配置保存失败');
  });
});
