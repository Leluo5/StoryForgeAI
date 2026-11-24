import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Workflow, WorkflowListItem } from '@storyforge/contracts';
import { WorkflowsPage } from './workflows-page';
import {
  listWorkflows,
  createWorkflow,
  updateWorkflow,
  archiveWorkflow,
  restoreWorkflow,
  deleteWorkflow,
  listWorkflowVersions,
  rollbackWorkflow
} from './workflow-client';

vi.mock('./workflow-client', () => ({
  listWorkflows: vi.fn(),
  createWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  archiveWorkflow: vi.fn(),
  restoreWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  listWorkflowVersions: vi.fn(),
  rollbackWorkflow: vi.fn()
}));

const baseWorkflow: WorkflowListItem = {
  id: 'wf-1',
  author_id: 'author-1',
  name: '主线创作',
  description: '按章节生成主线剧情',
  status: 'active',
  platform: 'coze',
  platform_config: { workflow_id: 'wf-abc', workspace_id: 'ws-xyz' },
  llm_config: { model: 'gpt-4o-mini' },
  source: 'manual',
  version_no: 3,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-03T00:00:00.000Z',
  archived_at: null
};

/** 完整工作流（含 versions 快照），用于 workflowResponse 类 mock */
const baseWorkflowFull: Workflow = { ...baseWorkflow, versions: [] };

function renderPage() {
  return render(<MemoryRouter initialEntries={['/workflows']}><Routes>
    <Route path="/workflows" element={<WorkflowsPage />} />
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listWorkflows).mockResolvedValue({ workflows: [], total: 0 });
  vi.mocked(listWorkflowVersions).mockResolvedValue({ versions: [], version_no: 3 });
});

describe('WorkflowsPage', () => {
  it('renders the header with title and subtitle', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: '工作流管理' })).toBeVisible();
    expect(screen.getByText('编排创作工作流：自动化流程与规则配置')).toBeVisible();
    // 空状态
    expect(await screen.findByText(/暂无工作流/)).toBeVisible();
  });

  it('renders a card per workflow with status badge and meta', async () => {
    vi.mocked(listWorkflows).mockResolvedValue({ workflows: [baseWorkflow], total: 1 });
    renderPage();
    expect(await screen.findByText('主线创作')).toBeVisible();
    expect(screen.getByText('按章节生成主线剧情')).toBeVisible();
    // 状态徽标（用 data-status 精确定位，避免与筛选下拉 option 文本歧义）
    expect(document.querySelector('[data-status="active"]')).toHaveTextContent('启用');
    expect(screen.getByText('Coze')).toBeVisible();
    expect(screen.getByText('模型：gpt-4o-mini')).toBeVisible();
    expect(screen.getByText('v3')).toBeVisible();
  });

  it('shows a disabled badge for disabled workflow', async () => {
    vi.mocked(listWorkflows).mockResolvedValue({
      workflows: [{ ...baseWorkflow, status: 'disabled' }], total: 1
    });
    renderPage();
    expect(await screen.findByText('停用', { selector: '[data-status="disabled"]' })).toBeVisible();
    // 停用状态显示「启用」按钮
    expect(screen.getByRole('button', { name: '启用' })).toBeVisible();
  });

  it('shows archived actions for archived workflow', async () => {
    vi.mocked(listWorkflows).mockResolvedValue({
      workflows: [{
        ...baseWorkflow, status: 'archived', archived_at: '2026-02-01T00:00:00.000Z'
      }], total: 1
    });
    renderPage();
    expect(await screen.findByText('已归档', { selector: '[data-status="archived"]' })).toBeVisible();
    expect(screen.getByRole('button', { name: '恢复' })).toBeVisible();
    // 归档态不显示编辑
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
  });

  it('filters workflows by keyword and status', async () => {
    renderPage();
    await userEvent.type(screen.getByPlaceholderText('搜索工作流名称 / 描述'), '主线');
    await waitFor(() => expect(listWorkflows).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: '主线', page: 1 })
    ));

    await userEvent.selectOptions(screen.getByLabelText('按状态过滤'), 'archived');
    await waitFor(() => expect(listWorkflows).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'archived', page: 1 })
    ));
  });

  it('creates a workflow via the inline form', async () => {
    vi.mocked(createWorkflow).mockResolvedValue({ workflow: baseWorkflowFull });
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: /新建工作流/ }));
    expect(screen.getByLabelText(/新建工作流/)).toBeVisible();

    await userEvent.type(screen.getByLabelText(/名称/), '支线生成');
    // 新建表单会预填 model: 'gpt-4o-mini'，必须先清空再输入，否则会被 append 成 'gpt-4o-miniclaude-3-5-sonnet'
    const modelInput = screen.getByLabelText(/模型（llm_config.model）/);
    await userEvent.clear(modelInput);
    await userEvent.type(modelInput, 'claude-3-5-sonnet');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    // 断言 createWorkflow 收到的完整载荷：默认字段 description 为空串、platform_config 为空对象
    await waitFor(() => expect(createWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      name: '支线生成',
      description: '',
      llm_config: { model: 'claude-3-5-sonnet' },
      platform_config: {}
    })));
  });

  it('edits a workflow and persists changes', async () => {
    vi.mocked(listWorkflows).mockResolvedValue({ workflows: [baseWorkflow], total: 1 });
    vi.mocked(updateWorkflow).mockResolvedValue({ workflow: baseWorkflowFull });
    renderPage();

    await screen.findByText('主线创作');
    await userEvent.click(screen.getByRole('button', { name: '编辑' }));
    const nameInput = screen.getByLabelText(/名称/);
    expect(nameInput).toHaveValue('主线创作');

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, '主线创作改');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(updateWorkflow).toHaveBeenCalledWith('wf-1', expect.objectContaining({
      name: '主线创作改'
    })));
  });

  it('toggles workflow status between active and disabled', async () => {
    vi.mocked(listWorkflows).mockResolvedValue({ workflows: [baseWorkflow], total: 1 });
    vi.mocked(updateWorkflow).mockResolvedValue({ workflow: baseWorkflowFull });
    renderPage();

    await screen.findByText('主线创作');
    await userEvent.click(screen.getByRole('button', { name: '停用' }));
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalledWith('wf-1', { status: 'disabled' }));
  });

  it('archives a workflow after confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(listWorkflows).mockResolvedValue({ workflows: [baseWorkflow], total: 1 });
    vi.mocked(archiveWorkflow).mockResolvedValue({ workflow: { ...baseWorkflowFull, status: 'archived' } });
    renderPage();

    await screen.findByText('主线创作');
    await userEvent.click(screen.getByRole('button', { name: '归档' }));

    await waitFor(() => expect(archiveWorkflow).toHaveBeenCalledWith('wf-1', { note: '手动归档' }));
    confirmSpy.mockRestore();
  });

  it('restores an archived workflow after confirmation', async () => {
    vi.mocked(listWorkflows).mockResolvedValue({
      workflows: [{ ...baseWorkflow, status: 'archived', archived_at: '2026-02-01T00:00:00.000Z' }], total: 1
    });
    vi.mocked(restoreWorkflow).mockResolvedValue({ workflow: baseWorkflowFull });
    renderPage();

    await screen.findByText('主线创作');
    await userEvent.click(screen.getByRole('button', { name: '恢复' }));

    await waitFor(() => expect(restoreWorkflow).toHaveBeenCalledWith('wf-1'));
  });

  it('deletes a workflow after confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(listWorkflows).mockResolvedValue({ workflows: [baseWorkflow], total: 1 });
    vi.mocked(deleteWorkflow).mockResolvedValue({ deleted: true, id: 'wf-1' });
    renderPage();

    await screen.findByText('主线创作');
    await userEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => expect(deleteWorkflow).toHaveBeenCalledWith('wf-1', true));
    confirmSpy.mockRestore();
  });

  it('opens version history and rolls back to a target version', async () => {
    vi.mocked(listWorkflows).mockResolvedValue({ workflows: [baseWorkflow], total: 1 });
    vi.mocked(listWorkflowVersions).mockResolvedValue({
      version_no: 3,
      versions: [
        { version_no: 3, change_type: 'update', note: '', created_at: '2026-01-03T00:00:00.000Z' },
        { version_no: 1, change_type: 'create', note: '', created_at: '2026-01-01T00:00:00.000Z' }
      ]
    });
    vi.mocked(rollbackWorkflow).mockResolvedValue({ workflow: baseWorkflowFull });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();

    await screen.findByText('主线创作');
    await userEvent.click(screen.getByRole('button', { name: '查看版本历史' }));

    expect(await screen.findByText('v1')).toBeVisible();
    // 组件为版本号 span 暴露了 data-version-no 属性；这里用 selector 精确定位版本列表项，
    // 避免与卡片 meta 里同样显示 "v3" 的文本歧义（getByText('v3') 会因多匹配而报错）
    expect(screen.getAllByText('v3', { selector: '[data-version-no]' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('v3', { selector: '[data-version-no]' })).toBeVisible();
    // 当前版本 v3 不显示回滚按钮，v1 显示
    const rollbackBtn = screen.getByRole('button', { name: '回滚到此版本' });
    await userEvent.click(rollbackBtn);

    await waitFor(() => expect(rollbackWorkflow).toHaveBeenCalledWith('wf-1', 1, { note: '回滚至 v1' }));
    confirmSpy.mockRestore();
  });

  it('surfaces a load error', async () => {
    vi.mocked(listWorkflows).mockRejectedValue(new Error('网络错误'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('网络错误');
  });
});
