import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CollabSettings, CollabReadiness } from '@storyforge/contracts';
import { CollabPanel } from './collab-panel';
import { collabClient } from './collab-client';

vi.mock('./collab-client', () => ({
  collabClient: {
    getSettings: vi.fn(),
    putSettings: vi.fn(),
    getReadiness: vi.fn(),
    createRoleProfileTask: vi.fn(),
    getTaskDetail: vi.fn(),
    revertWritebackField: vi.fn(),
    listCollabAgents: vi.fn(),
    listCharacters: vi.fn(),
    subscribeTaskEvents: vi.fn()
  }
}));

const workId = crypto.randomUUID();
const characterId = crypto.randomUUID();
const agentId = crypto.randomUUID();

function settings(overrides: Partial<CollabSettings> = {}): CollabSettings {
  return {
    work_id: workId,
    test_character_id: characterId,
    agent_id: agentId,
    whitelist_fields: ['identity', 'personality', 'experience'],
    enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides
  };
}

function readiness(overrides: Partial<CollabReadiness> = {}): CollabReadiness {
  return {
    settings: { enabled: true, test_character_id: characterId, agent_id: agentId },
    channels: { flowise: { configured: true }, coze: { configured: false } },
    retrieval: { configured: false },
    archive: { configured: false },
    ...overrides
  };
}

const getSettings = vi.mocked(collabClient.getSettings);
const getReadiness = vi.mocked(collabClient.getReadiness);
const putSettings = vi.mocked(collabClient.putSettings);
const createRoleProfileTask = vi.mocked(collabClient.createRoleProfileTask);
const listCollabAgents = vi.mocked(collabClient.listCollabAgents);
const listCharacters = vi.mocked(collabClient.listCharacters);
const getTaskDetail = vi.mocked(collabClient.getTaskDetail);

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue(settings());
  getReadiness.mockResolvedValue(readiness());
  listCollabAgents.mockResolvedValue([{ id: agentId, name: 'Flowise Agent', platform: 'flowise', model_id: 'x' } as never]);
  listCharacters.mockResolvedValue({ items: [{ id: characterId, name: '测试角色' }] });
  putSettings.mockResolvedValue(settings());
  createRoleProfileTask.mockResolvedValue({ task: { id: 'task-1', status: 'queued', channel: 'flowise', error: null } });
  getTaskDetail.mockResolvedValue({
    task: { id: 'task-1', status: 'queued', channel: 'flowise', error: null },
    citations: [],
    writeback: null,
    archive: null
  });
});

describe('CollabPanel（AI 协同）', () => {
  it('未配置协同设置时显示引导提示', async () => {
    getSettings.mockResolvedValue(null);
    render(<CollabPanel workId={workId} characterId={characterId} />);
    expect(await screen.findByText(/尚未配置协同设置/)).toBeVisible();
  });

  it('非测试角色显示只读提示', async () => {
    const other = crypto.randomUUID();
    render(<CollabPanel workId={workId} characterId={other} />);
    expect(await screen.findByText(/当前角色非作品测试角色/)).toBeVisible();
  });

  it('测试角色显示设置表单与发起表单', async () => {
    render(<CollabPanel workId={workId} characterId={characterId} />);
    expect(await screen.findByText('协同设置')).toBeVisible();
    expect(await screen.findByText('发起角色资料生成')).toBeVisible();
    expect(screen.getAllByText('测试角色').length).toBeGreaterThan(0);
    expect(screen.getByText('执行 Agent')).toBeVisible();
  });

  it('发起生成调用 createRoleProfileTask 并显示进度', async () => {
    const user = userEvent.setup();
    render(<CollabPanel workId={workId} characterId={characterId} />);
    await screen.findByText('发起角色资料生成');
    const instruction = screen.getByPlaceholderText(/例：为这位角色/);
    await user.type(instruction, '补充一段冒险经历');
    await user.click(screen.getByRole('button', { name: '发起生成' }));
    await waitFor(() => {
      expect(createRoleProfileTask).toHaveBeenCalledWith(
        workId,
        expect.objectContaining({ character_id: characterId, instruction: '补充一段冒险经历' })
      );
    });
    expect(await screen.findByText('任务进度')).toBeVisible();
  });

  it('通道未就绪时隐藏发起表单并提示', async () => {
    getReadiness.mockResolvedValue(readiness({ channels: { flowise: { configured: false }, coze: { configured: false } } }));
    render(<CollabPanel workId={workId} characterId={characterId} />);
    expect(await screen.findByText(/执行通道未就绪/)).toBeVisible();
    expect(screen.queryByText('发起角色资料生成')).not.toBeInTheDocument();
  });

  it('协同关闭时不显示发起表单', async () => {
    getSettings.mockResolvedValue(settings({ enabled: false }));
    render(<CollabPanel workId={workId} characterId={characterId} />);
    await screen.findByText('协同设置');
    expect(screen.queryByText('发起角色资料生成')).not.toBeInTheDocument();
  });
});
