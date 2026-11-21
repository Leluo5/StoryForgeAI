import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, beforeAll } from 'vitest';

// jsdom 的 File.prototype.text 可能未实现，统一 mock 以便 handleFile 读取内容
beforeAll(() => {
  if (!('text' in File.prototype)) {
    Object.defineProperty(File.prototype, 'text', {
      configurable: true,
      value: function text() { return Promise.resolve(''); }
    });
  }
});
import { KnowledgePanel } from './knowledge-panel';
import type { ImportPreviewItem } from '@storyforge/contracts';

// mock 客户端，隔离组件逻辑，聚焦渲染与交互流
vi.mock('./knowledge-client', () => ({
  createEntryPreview: vi.fn(),
  commitEntry: vi.fn(),
  searchEntries: vi.fn(),
  getEntry: vi.fn(),
  updateEntry: vi.fn(),
  deleteEntry: vi.fn(),
  linkEntry: vi.fn(),
  extractOutline: vi.fn(),
  exportMarkdown: vi.fn(),
  importPreview: vi.fn(),
  importMarkdown: vi.fn(),
  validateMarkdown: vi.fn()
}));

import {
  createEntryPreview, commitEntry, searchEntries, getEntry, deleteEntry,
  extractOutline, importPreview, importMarkdown, exportMarkdown
} from './knowledge-client';

const mocked = vi.mocked({
  createEntryPreview, commitEntry, searchEntries, getEntry, deleteEntry,
  extractOutline, importPreview, importMarkdown, exportMarkdown
});

beforeEach(() => {
  vi.clearAllMocks();
  mocked.searchEntries.mockResolvedValue({ total: 0, items: [] } as never);
});

describe('KnowledgePanel 入口', () => {
  it('渲染标题与三个功能页签，默认显示录入', () => {
    render(<KnowledgePanel />);
    expect(screen.getByText('知识库')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '录入' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '检索' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '导入导出' })).toBeInTheDocument();
    expect(screen.getByLabelText('知识录入')).toBeInTheDocument();
  });

  it('切换到检索页签并自动加载列表', async () => {
    render(<KnowledgePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '检索' }));
    await waitFor(() => expect(mocked.searchEntries).toHaveBeenCalled());
    expect(screen.getByLabelText('知识检索')).toBeInTheDocument();
  });

  it('切换到导入导出页签', () => {
    render(<KnowledgePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '导入导出' }));
    expect(screen.getByLabelText('Markdown 导入导出')).toBeInTheDocument();
  });
});

describe('录入流程', () => {
  it('空内容点生成预览给出错误提示', async () => {
    render(<KnowledgePanel />);
    fireEvent.click(screen.getByRole('button', { name: '生成预览' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('请输入内容'));
    expect(mocked.createEntryPreview).not.toHaveBeenCalled();
  });

  it('预览返回结构化结果后渲染确认入库按钮', async () => {
    mocked.createEntryPreview.mockResolvedValue({
      status: 'preview', id: 'k1', type: 'article',
      title: '示例文章', structured: { summary: '摘要', paragraphs: ['段一'] }, tags: []
    });
    render(<KnowledgePanel />);
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: '这是一篇文章内容' } });
    fireEvent.click(screen.getByRole('button', { name: '生成预览' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '确认入库' })).toBeInTheDocument());
    expect(screen.getByText('预览 · 文章')).toBeInTheDocument();
    expect(screen.getByLabelText('摘要')).toHaveValue('摘要');
  });

  it('type_uncertain 时提示手动指定类型', async () => {
    mocked.createEntryPreview.mockResolvedValue({ status: 'type_uncertain' });
    render(<KnowledgePanel />);
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: '无法识别内容' } });
    fireEvent.click(screen.getByRole('button', { name: '生成预览' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('无法自动确定知识类型'));
  });

  it('确认入库调用 commitEntry 并清空表单', async () => {
    mocked.createEntryPreview.mockResolvedValue({
      status: 'preview', id: 'k1', type: 'novel',
      title: '小说', structured: { characters: ['主角'] }, tags: []
    });
    mocked.commitEntry.mockResolvedValue({} as never);
    render(<KnowledgePanel />);
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: '小说正文' } });
    fireEvent.click(screen.getByRole('button', { name: '生成预览' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '确认入库' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '确认入库' }));
    await waitFor(() => expect(mocked.commitEntry).toHaveBeenCalled());
    expect(mocked.commitEntry.mock.calls[0]![1].structured).toEqual({ characters: ['主角'] });
    await waitFor(() => expect(screen.queryByRole('button', { name: '确认入库' })).not.toBeInTheDocument());
  });
});

describe('检索流程', () => {
  it('列表无结果时显示空态', async () => {
    mocked.searchEntries.mockResolvedValue({ total: 0, items: [] } as never);
    render(<KnowledgePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '检索' }));
    await waitFor(() => expect(screen.getByText('暂无匹配条目，试试放宽筛选条件。')).toBeInTheDocument());
  });

  it('点击条目卡片进入详情并展示结构化', async () => {
    mocked.searchEntries.mockResolvedValue({
      total: 1,
      items: [{ id: 'k1', type: 'article', title: '测试文章', tags: ['科幻'], created_at: new Date().toISOString() }]
    } as never);
    mocked.getEntry.mockResolvedValue({
      id: 'k1', type: 'article', title: '测试文章', source: 'paste',
      raw_content: '原文', structured: { summary: '详情摘要' }, tags: ['科幻'],
      links: [], content_hash: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as never);
    render(<KnowledgePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '检索' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /测试文章/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /测试文章/ }));
    await waitFor(() => expect(mocked.getEntry).toHaveBeenCalledWith('k1'));
    await waitFor(() => expect(screen.getByText(/详情摘要/)).toBeInTheDocument());
  });

  it('小说详情可提取大纲，无章节提示', async () => {
    mocked.searchEntries.mockResolvedValue({
      total: 1,
      items: [{ id: 'k1', type: 'novel', title: '长篇小说', tags: [], created_at: new Date().toISOString() }]
    } as never);
    mocked.getEntry.mockResolvedValue({
      id: 'k1', type: 'novel', title: '长篇小说', source: 'paste',
      raw_content: '正文', structured: {}, tags: [], links: [],
      content_hash: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as never);
    mocked.extractOutline.mockResolvedValue({ novel_id: 'k1', error: 'no_chapters' });
    render(<KnowledgePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '检索' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /长篇小说/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /长篇小说/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: '提取大纲' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '提取大纲' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('未识别到章节标题'));
  });

  it('删除条目后刷新列表', async () => {
    mocked.searchEntries.mockResolvedValue({
      total: 1,
      items: [{ id: 'k1', type: 'article', title: '待删除', tags: [], created_at: new Date().toISOString() }]
    } as never);
    mocked.getEntry.mockResolvedValue({
      id: 'k1', type: 'article', title: '待删除', source: 'paste',
      raw_content: '正文', structured: {}, tags: [], links: [],
      content_hash: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as never);
    mocked.deleteEntry.mockResolvedValue({ ok: true });
    render(<KnowledgePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '检索' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /待删除/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /待删除/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(mocked.deleteEntry).toHaveBeenCalledWith('k1'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已删除'));
  });
});

describe('Markdown 导入导出', () => {
  it('选择非 md 文件给出错误', async () => {
    render(<KnowledgePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '导入导出' }));
    const input = screen.getByLabelText(/选择 Markdown 文件/) as HTMLInputElement;
    const bad = new File(['x'], 'a.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [bad] } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('仅支持 .md'));
  });

  it('md 文件预览后出现确认导入按钮', async () => {
    const item: ImportPreviewItem = { file_name: 'a.md', title: 'A', type: 'article', content: '# A', conflict: 'new' };
    mocked.importPreview.mockResolvedValue({ items: [item] });
    render(<KnowledgePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '导入导出' }));
    const input = screen.getByLabelText(/选择 Markdown 文件/) as HTMLInputElement;
    const file = new File(['# A'], 'a.md', { type: 'text/markdown' });
    // jsdom 的 File.text 返回空串，覆盖为真实内容供 handleFile 读取
    Object.defineProperty(file, 'text', { configurable: true, value: () => Promise.resolve('# A') });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText('已选择：a.md（3 字符）')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '预览' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '确认导入' })).toBeInTheDocument());
  });

  it('导出单文件触发下载', async () => {
    mocked.exportMarkdown.mockResolvedValue({
      total: 1, mode: 'single', content: '# 导出的知识', file_name: 'out.md'
    });
    const anchorSpy = vi.spyOn(window.document, 'createElement');
    render(<KnowledgePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '导入导出' }));
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    await waitFor(() => expect(mocked.exportMarkdown).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('导出完成：1 条'));
    expect(anchorSpy).toHaveBeenCalled();
  });
});
