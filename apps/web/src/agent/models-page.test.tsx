import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Model, ModelListItem } from '@storyforge/contracts';
import { ModelsPage } from './models-page';
import { listModels, createModel, updateModel, deleteModel } from './model-client';

vi.mock('./model-client', () => ({
  listModels: vi.fn(),
  createModel: vi.fn(),
  updateModel: vi.fn(),
  deleteModel: vi.fn()
}));

const baseModel: ModelListItem = {
  id: 'model-1',
  author_id: 'author-1',
  name: 'GPT-4o Mini',
  provider: 'openai',
  model_id: 'gpt-4o-mini',
  context_window: 128000,
  supports_tools: true,
  supports_vision: true,
  input_price: 0.15,
  output_price: 0.6,
  currency: 'USD',
  status: 'active',
  sort_order: 10,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-03T00:00:00.000Z'
};

const baseModelFull: Model = { ...baseModel };

function renderPage() {
  return render(<MemoryRouter initialEntries={['/models']}><Routes>
    <Route path="/models" element={<ModelsPage />} />
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listModels).mockResolvedValue({ models: [], total: 0 });
});

describe('ModelsPage', () => {
  it('renders the header with title and subtitle', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: '模型管理' })).toBeVisible();
    expect(screen.getByText('配置与管理 AI 模型选型目录：能力、价格与调用策略')).toBeVisible();
    // 空状态
    expect(await screen.findByText(/暂无模型/)).toBeVisible();
  });

  it('renders a card per model with badge, provider, model_id, capabilities and price', async () => {
    vi.mocked(listModels).mockResolvedValue({ models: [baseModel], total: 1 });
    renderPage();
    expect(await screen.findByText('GPT-4o Mini')).toBeVisible();
    // 状态徽标（data-status 精确定位）
    expect(document.querySelector('[data-status="active"]')).toHaveTextContent('启用');
    expect(screen.getByText('OpenAI')).toBeVisible();
    expect(screen.getByText('gpt-4o-mini')).toBeVisible();
    expect(screen.getByText(/128,000 ctx/)).toBeVisible();
    // 能力徽章
    expect(screen.getByText('工具调用 ✓')).toBeVisible();
    expect(screen.getByText('视觉 ✓')).toBeVisible();
    // 价格徽章
    expect(screen.getByText('输入 0.15 USD / 1K')).toBeVisible();
    expect(screen.getByText('输出 0.6 USD / 1K')).toBeVisible();
    expect(screen.getByText('排序 10')).toBeVisible();
  });

  it('shows a disabled badge for disabled model', async () => {
    vi.mocked(listModels).mockResolvedValue({
      models: [{ ...baseModel, status: 'disabled' }], total: 1
    });
    renderPage();
    expect(await screen.findByText('停用', { selector: '[data-status="disabled"]' })).toBeVisible();
    // 停用状态显示「启用」按钮
    expect(screen.getByRole('button', { name: '启用' })).toBeVisible();
  });

  it('filters models by keyword and status', async () => {
    renderPage();
    await userEvent.type(screen.getByPlaceholderText('搜索模型名称 / 标识'), 'gpt');
    await waitFor(() => expect(listModels).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: 'gpt', page: 1 })
    ));

    await userEvent.selectOptions(screen.getByLabelText('按状态过滤'), 'disabled');
    await waitFor(() => expect(listModels).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'disabled', page: 1 })
    ));
  });

  it('creates a model via the inline form with numeric conversion and defaults', async () => {
    vi.mocked(createModel).mockResolvedValue({ model: baseModelFull });
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: /新建模型/ }));
    expect(screen.getByLabelText(/新建模型/)).toBeVisible();

    await userEvent.type(screen.getByLabelText(/名称/), 'Claude 3.5 Sonnet');
    await userEvent.type(screen.getByLabelText(/能力标识（model_id）/), 'claude-3-5-sonnet');
    await userEvent.type(screen.getByLabelText(/上下文窗口/), '200000');
    await userEvent.type(screen.getByLabelText(/输入价格/), '3');
    await userEvent.type(screen.getByLabelText(/输出价格/), '15');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(createModel).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Claude 3.5 Sonnet',
      model_id: 'claude-3-5-sonnet',
      provider: 'openai',
      context_window: 200000,
      input_price: 3,
      output_price: 15,
      currency: 'USD',
      sort_order: 0
    })));
  });

  it('edits a model and persists changes', async () => {
    vi.mocked(listModels).mockResolvedValue({ models: [baseModel], total: 1 });
    vi.mocked(updateModel).mockResolvedValue({ model: baseModelFull });
    renderPage();

    await screen.findByText('GPT-4o Mini');
    await userEvent.click(screen.getByRole('button', { name: '编辑' }));
    const nameInput = screen.getByLabelText(/名称/);
    expect(nameInput).toHaveValue('GPT-4o Mini');

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'GPT-4o Mini 改');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(updateModel).toHaveBeenCalledWith('model-1', expect.objectContaining({
      name: 'GPT-4o Mini 改'
    })));
  });

  it('toggles model status between active and disabled', async () => {
    vi.mocked(listModels).mockResolvedValue({ models: [baseModel], total: 1 });
    vi.mocked(updateModel).mockResolvedValue({ model: baseModelFull });
    renderPage();

    await screen.findByText('GPT-4o Mini');
    await userEvent.click(screen.getByRole('button', { name: '停用' }));
    await waitFor(() => expect(updateModel).toHaveBeenCalledWith('model-1', { status: 'disabled' }));
  });

  it('deletes a model directly after confirmation (no force)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(listModels).mockResolvedValue({ models: [baseModel], total: 1 });
    vi.mocked(deleteModel).mockResolvedValue({ deleted: true, id: 'model-1' });
    renderPage();

    await screen.findByText('GPT-4o Mini');
    await userEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => expect(deleteModel).toHaveBeenCalledWith('model-1'));
    confirmSpy.mockRestore();
  });

  it('surfaces a load error', async () => {
    vi.mocked(listModels).mockRejectedValue(new Error('网络错误'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('网络错误');
  });
});
