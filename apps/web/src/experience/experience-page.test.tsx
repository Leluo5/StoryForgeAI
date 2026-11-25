import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatExperienceEvent, PublicWork } from '@storyforge/contracts';
import { chatStream, getPublicWork, listPublicWorks, verifyWorkAccess } from './experience-client';
import { ExperienceChatPage, ExperiencePage } from './experience-page';

vi.mock('./experience-client', () => ({
  listPublicWorks: vi.fn(),
  getPublicWork: vi.fn(),
  verifyWorkAccess: vi.fn(),
  chatStream: vi.fn()
}));

function work(overrides: Partial<PublicWork> = {}): PublicWork {
  return {
    id: crypto.randomUUID(), name: '雾岛守夜', description: '守夜人的故事',
    icon_url: null, coze_bot_id: 'bot-1', interaction_type: 'chat',
    system_prompt: null, prologue: null, suggested_questions: [], parameters: [],
    model_name: null, response_format: null, requires_access_code: false,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides
  };
}

function renderList() {
  return render(<MemoryRouter initialEntries={['/experience']}><Routes>
    <Route path="/experience" element={<ExperiencePage />} />
    <Route path="/experience/works/:workId" element={<div>聊天页深链</div>} />
  </Routes></MemoryRouter>);
}

function renderChat(workId: string) {
  return render(<MemoryRouter initialEntries={[`/experience/works/${workId}`]}><Routes>
    <Route path="/experience" element={<div>列表页</div>} />
    <Route path="/experience/works/:workId" element={<ExperienceChatPage />} />
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  // jsdom 未实现 scrollIntoView，组件滚动日志依赖它，测试环境补桩
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  vi.mocked(listPublicWorks).mockReset();
  vi.mocked(getPublicWork).mockReset();
  vi.mocked(verifyWorkAccess).mockReset();
  vi.mocked(chatStream).mockReset();
});

describe('ExperiencePage', () => {
  it('renders public works and marks access-code works with a lock badge', async () => {
    const free = work({ name: '公开作品' });
    const locked = work({ name: '受限作品', requires_access_code: true });
    vi.mocked(listPublicWorks).mockResolvedValue({ works: [free, locked] });
    renderList();
    expect(await screen.findByText('公开作品')).toBeVisible();
    expect(screen.getByText('受限作品')).toBeVisible();
    // 仅设访问码的作品展示「需访问码」徽标
    expect(screen.getByText('需访问码')).toBeVisible();
    expect(screen.getByText('公开作品').closest('button')).not.toHaveTextContent('需访问码');
  });

  it('navigates to the chat page when a work card is clicked', async () => {
    const target = work({ name: '雾岛守夜' });
    vi.mocked(listPublicWorks).mockResolvedValue({ works: [target] });
    renderList();
    await userEvent.click(await screen.findByRole('button', { name: '进入 雾岛守夜' }));
    expect(await screen.findByText('聊天页深链')).toBeVisible();
  });
});

describe('ExperienceChatPage', () => {
  it('enters chat directly when no access code is required', async () => {
    vi.mocked(getPublicWork).mockResolvedValue(work({ name: '自由作品', prologue: '欢迎光临' }));
    renderChat(crypto.randomUUID());
    expect(await screen.findByText('欢迎光临')).toBeVisible();
    expect(screen.getByPlaceholderText('发消息给角色…')).toBeVisible();
  });

  it('asks for access code when required and verifies it before chat', async () => {
    const id = crypto.randomUUID();
    vi.mocked(getPublicWork).mockResolvedValue(work({ id, name: '受限作品', requires_access_code: true }));
    vi.mocked(verifyWorkAccess).mockResolvedValue({ granted: true, token: 'tok-1' });
    renderChat(id);
    expect(await screen.findByLabelText('该作品需要访问码才能体验')).toBeVisible();
    await userEvent.type(screen.getByLabelText('该作品需要访问码才能体验'), 'SUN-2026');
    await userEvent.click(screen.getByRole('button', { name: '进入' }));
    // 验证通过后进入聊天输入区，并持久化访问 token
    expect(await screen.findByPlaceholderText('发消息给角色…')).toBeVisible();
    expect(verifyWorkAccess).toHaveBeenCalledWith(id, { access_code: 'SUN-2026' });
    expect(localStorage.getItem(`storyforge_access_${id}`)).toBe('tok-1');
  });

  it('streams assistant deltas and finishes with the conversation id', async () => {
    const id = crypto.randomUUID();
    vi.mocked(getPublicWork).mockResolvedValue(work({ id, name: '流式作品' }));
    const events: ChatExperienceEvent[] = [
      { type: 'delta', content: '你好' },
      { type: 'delta', content: '，世界' },
      { type: 'done', conversation_id: 'conv-9' }
    ];
    vi.mocked(chatStream).mockImplementation(async (_workId, _input, _token, onEvent) => {
      for (const event of events) onEvent(event);
    });
    renderChat(id);
    await userEvent.type(await screen.findByPlaceholderText('发消息给角色…'), '在吗');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    // 增量内容逐帧累积为「你好，世界」，完成后恢复输入可用
    expect(await screen.findByText('你好，世界')).toBeVisible();
    expect(chatStream).toHaveBeenCalledTimes(1);
    // 发送后输入框被清空，发送按钮因内容为空而禁用（组件正确行为）；输入框恢复可编辑
    expect(screen.getByPlaceholderText('发消息给角色…')).toBeEnabled();
  });

  it('surfaces an error event and keeps the assistant bubble', async () => {
    const id = crypto.randomUUID();
    vi.mocked(getPublicWork).mockResolvedValue(work({ id, name: '出错作品' }));
    vi.mocked(chatStream).mockImplementation(async (_w, _i, _t, onEvent) => {
      onEvent({ type: 'error', message: '上游超时' });
    });
    renderChat(id);
    await userEvent.type(await screen.findByPlaceholderText('发消息给角色…'), '测试');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('上游超时')).toBeVisible();
    // 错误后输入框恢复可编辑（不再处于流式中）
    expect(screen.getByPlaceholderText('发消息给角色…')).toBeEnabled();
  });
});
