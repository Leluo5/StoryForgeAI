// ============================================================================
// M3c-3 知识库 · 导入导出面板（T35）
// 依据：docs/04-功能交付档案/M3c-3-知识库/03-任务规划.md T35 完成标准
//
// 覆盖：
//   - 导出范围单选（当前筛选 / 全部）并回调 onExport(range)
//   - 选择 Markdown 文件触发 onImportPreview(files)
//   - 展示导入预览统计（重复 / 同名冲突 / 新增）
//   - 冲突策略 overwrite/rename/skip 单选生效并回调 onImportCommit({preview_id, policy})
//   - 错误 role=alert；loading
// ============================================================================

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ImportExport } from './import-export';
import type { KnowledgeImportPreviewResponse } from '@storyforge/contracts';

const previewId = '11111111-1111-4111-8111-111111111111';

const preview: KnowledgeImportPreviewResponse = {
  preview_id: previewId,
  files: [
    { file_name: 'a.md', title: 'A', entry_type: 'article', excerpt: 'x', size: 100, conflict: 'duplicate' },
    { file_name: 'b.md', title: 'B', entry_type: 'paper', excerpt: 'y', size: 200, conflict: 'name_collision' },
    { file_name: 'c.md', title: 'C', entry_type: 'novel', excerpt: 'z', size: 300, conflict: 'new' }
  ],
  conflicts: [
    { file_index: 0, file_name: 'a.md', reason: 'duplicate' },
    { file_index: 1, file_name: 'b.md', reason: 'name_collision' }
  ],
  summary: { total: 3, duplicate: 1, name_collision: 1, new: 1, failed: 0 }
};

describe('ImportExport', () => {
  it('calls onExport with all when export all selected', async () => {
    const onExport = vi.fn();
    render(<ImportExport scope="global" onExport={onExport} />);
    await userEvent.click(screen.getByRole('radio', { name: '导出全部' }));
    await userEvent.click(screen.getByRole('button', { name: '导出 Markdown' }));
    expect(onExport).toHaveBeenCalledWith('all');
  });

  it('calls onExport with selection when selection selected', async () => {
    const onExport = vi.fn();
    render(<ImportExport scope="global" onExport={onExport} />);
    await userEvent.click(screen.getByRole('radio', { name: '导出当前筛选' }));
    await userEvent.click(screen.getByRole('button', { name: '导出 Markdown' }));
    expect(onExport).toHaveBeenCalledWith('selection');
  });

  it('calls onImportPreview when files selected', async () => {
    const onImportPreview = vi.fn();
    render(<ImportExport scope="global" onImportPreview={onImportPreview} />);
    const input = screen.getByLabelText('选择 Markdown 文件') as HTMLInputElement;
    const file = new File(['# A'], 'a.md', { type: 'text/markdown' });
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);
    expect(onImportPreview).toHaveBeenCalledWith([file]);
  });

  it('renders preview summary', () => {
    render(<ImportExport scope="global" preview={preview} />);
    expect(screen.getByText('共 3 个文件')).toBeInTheDocument();
    expect(screen.getByText('重复 1')).toBeInTheDocument();
    expect(screen.getByText('同名冲突 1')).toBeInTheDocument();
    expect(screen.getByText('新增 1')).toBeInTheDocument();
  });

  it('selects conflict policy and commits', async () => {
    const onImportCommit = vi.fn();
    render(<ImportExport scope="global" preview={preview} onImportCommit={onImportCommit} />);
    await userEvent.click(screen.getByRole('radio', { name: '重命名' }));
    await userEvent.click(screen.getByRole('button', { name: '确认导入' }));
    expect(onImportCommit).toHaveBeenCalledWith({ preview_id: previewId, policy: 'rename' });
  });

  it('shows error alert', () => {
    render(<ImportExport scope="global" error="导入失败。" />);
    expect(screen.getByRole('alert')).toHaveTextContent('导入失败');
  });

  it('disables export while loading', () => {
    render(<ImportExport scope="global" loading />);
    expect(screen.getByRole('button', { name: '导出 Markdown' })).toBeDisabled();
  });
});
