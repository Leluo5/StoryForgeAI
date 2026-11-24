// ============================================================================
// M3c-3 知识库 · 备份恢复面板（T35）
// 依据：docs/04-功能交付档案/M3c-3-知识库/03-任务规划.md T35 完成标准
//
// 覆盖：
//   - 备份下载回调 onBackup(scope)
//   - 选择备份文件触发 onRestorePreview(files)
//   - 恢复 preview→commit 两段式：展示统计（同内容 / 同名不同内容 / 新增）
//   - 冲突策略单选并回调 onRestoreCommit({preview_id, policy})
//   - 错误 role=alert；loading
// ============================================================================

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BackupPanel } from './backup-panel';
import type { KnowledgeRestorePreviewResponse } from '@storyforge/contracts';

const previewId = '11111111-1111-4111-8111-111111111111';

const restorePreview: KnowledgeRestorePreviewResponse = {
  preview_id: previewId,
  file_name: 'backup.json.gz',
  uncompressed_bytes: 1024,
  summary: { total: 5, same_content: 2, same_title_diff_content: 1, new: 2 },
  conflicts: [
    { entry_index: 0, local_id: 'l-1', title: 'A', type: 'same_content' },
    { entry_index: 1, local_id: 'l-2', title: 'B', type: 'same_title_diff_content' }
  ]
};

describe('BackupPanel', () => {
  it('calls onBackup with scope', async () => {
    const onBackup = vi.fn();
    render(<BackupPanel scope="global" onBackup={onBackup} />);
    await userEvent.click(screen.getByRole('button', { name: '导出整库备份' }));
    expect(onBackup).toHaveBeenCalledWith('global');
  });

  it('calls onRestorePreview when backup file selected', async () => {
    const onRestorePreview = vi.fn();
    render(<BackupPanel scope="global" onRestorePreview={onRestorePreview} />);
    const input = screen.getByLabelText('选择备份文件') as HTMLInputElement;
    const file = new File(['{}'], 'backup.json.gz', { type: 'application/gzip' });
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);
    expect(onRestorePreview).toHaveBeenCalledWith([file]);
  });

  it('renders restore preview summary', () => {
    render(<BackupPanel scope="global" restorePreview={restorePreview} />);
    expect(screen.getByText('同内容 2')).toBeInTheDocument();
    expect(screen.getByText('同名不同内容 1')).toBeInTheDocument();
    expect(screen.getByText('新增 2')).toBeInTheDocument();
  });

  it('selects conflict policy and commits restore', async () => {
    const onRestoreCommit = vi.fn();
    render(<BackupPanel scope="global" restorePreview={restorePreview} onRestoreCommit={onRestoreCommit} />);
    await userEvent.click(screen.getByRole('radio', { name: '覆盖' }));
    await userEvent.click(screen.getByRole('button', { name: '确认恢复' }));
    expect(onRestoreCommit).toHaveBeenCalledWith({ preview_id: previewId, policy: 'overwrite' });
  });

  it('shows error alert', () => {
    render(<BackupPanel scope="global" error="恢复失败。" />);
    expect(screen.getByRole('alert')).toHaveTextContent('恢复失败');
  });

  it('disables backup while loading', () => {
    render(<BackupPanel scope="global" loading />);
    expect(screen.getByRole('button', { name: '导出整库备份' })).toBeDisabled();
  });
});
