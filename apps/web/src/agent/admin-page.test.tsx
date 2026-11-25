import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SiteConfigResponse } from '@storyforge/contracts';
import { AdminPage } from './admin-page';
import { getSiteConfig, updateSiteConfig } from './site-config-client';

vi.mock('./site-config-client', () => ({
  getSiteConfig: vi.fn(),
  updateSiteConfig: vi.fn()
}));

const defaultConfig: SiteConfigResponse = {
  site_name: '我的创作站',
  site_description: '',
  theme: 'light',
  llm_config: {},
  platform_credentials: {}
};

function renderPage() {
  return render(<MemoryRouter initialEntries={['/admin']}><Routes>
    <Route path="/admin" element={<AdminPage />} />
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSiteConfig).mockResolvedValue({ config: defaultConfig });
});

describe('AdminPage', () => {
  it('renders the site settings page with title and sections', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: '站点设置' })).toBeVisible();
    expect(await screen.findByRole('heading', { name: '站点信息' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'LLM 配置' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '平台凭据' })).toBeVisible();
    expect(screen.getByRole('button', { name: '保存设置' })).toBeVisible();
  });

  it('loads existing config values into the form', async () => {
    vi.mocked(getSiteConfig).mockResolvedValue({
      config: {
        ...defaultConfig,
        site_name: '我的故事站',
        site_description: '创作与发布平台',
        theme: 'dark',
        llm_config: { base_url: 'https://llm.example.com', api_key: 'sk-test', model: 'gpt-4o-mini' },
        platform_credentials: {
          coze: { base_url: 'https://api.coze.cn', pat: 'pat_123' },
          flowise: { base_url: 'https://flowise.example.com', api_key: 'fl_key' },
          fastgpt: { base_url: 'https://fastgpt.example.com', api_key: 'fg_key', dataset_id: 'ds-1' },
          n8n: { webhook_url: 'https://n8n.example.com/webhook', token: 'n8n_tok' }
        }
      }
    });
    renderPage();

    const nameInput = await screen.findByLabelText(/站点名称/);
    expect(nameInput).toHaveValue('我的故事站');
    expect(screen.getByLabelText(/站点描述/)).toHaveValue('创作与发布平台');
    // 用 display value 断言填充值，避免多个「API 密钥」标签歧义
    expect(screen.getByDisplayValue('https://llm.example.com')).toBeVisible();
    expect(screen.getByDisplayValue('sk-test')).toBeVisible();
    expect(screen.getByDisplayValue('gpt-4o-mini')).toBeVisible();
    // Coze 导入面板复用站点设置的 PAT（defaultPat 预填），故同一值出现在两个输入框
    const patInputs = screen.getAllByDisplayValue('pat_123');
    expect(patInputs.length).toBeGreaterThan(0);
    patInputs.forEach((el) => expect(el).toBeVisible());
    expect(screen.getByDisplayValue('ds-1')).toBeVisible();
  });

  it('saves the form and shows a notice', async () => {
    vi.mocked(updateSiteConfig).mockResolvedValue({ config: { ...defaultConfig, site_name: '我的故事站' } });
    renderPage();

    await screen.findByRole('heading', { name: '站点信息' });
    await userEvent.type(screen.getByLabelText(/站点名称/), '我的故事站');
    await userEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(updateSiteConfig).toHaveBeenCalled());
    expect(await screen.findByText('已保存')).toBeVisible();
  });

  it('surfaces a load error', async () => {
    vi.mocked(getSiteConfig).mockRejectedValue(new Error('网络错误'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('网络错误');
  });
});
