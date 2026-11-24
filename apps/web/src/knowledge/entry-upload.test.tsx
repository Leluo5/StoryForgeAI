import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EntryUpload, validateUploadFiles, UPLOAD_MAX_BYTES } from './entry-upload';
import { knowledgeClient } from './knowledge-client';

vi.mock('./knowledge-client', () => ({
  knowledgeClient: {
    uploadFiles: vi.fn()
  }
}));

const uploadFiles = knowledgeClient.uploadFiles as ReturnType<typeof vi.fn>;

const makeFile = (name: string, size = 100): File => {
  const file = new File(['x'.repeat(size)], name, { type: 'text/plain' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

describe('validateUploadFiles', () => {
  it('accepts the five supported extensions', () => {
    const result = validateUploadFiles([
      makeFile('a.txt'),
      makeFile('b.md'),
      makeFile('c.docx'),
      makeFile('d.pdf'),
      makeFile('e.html')
    ]);
    expect(result.accepted).toHaveLength(5);
    expect(result.rejected).toHaveLength(0);
  });

  it('rejects unsupported extensions', () => {
    const result = validateUploadFiles([makeFile('a.exe'), makeFile('b.png')]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0]?.reason).toContain('不支持的文件类型');
  });

  it('rejects files over 20MB', () => {
    const result = validateUploadFiles([makeFile('big.txt', UPLOAD_MAX_BYTES + 1)]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain('20MB');
  });

  it('caps at ten files', () => {
    const result = validateUploadFiles(Array.from({ length: 12 }, (_, i) => makeFile(`f${i}.txt`)));
    expect(result.accepted).toHaveLength(10);
  });

  it('derives lowercased extension', () => {
    expect(validateUploadFiles([makeFile('A.TXT')]).accepted).toHaveLength(1);
  });
});

describe('EntryUpload', () => {
  beforeEach(() => {
    uploadFiles.mockReset();
  });

  it('shows the dropzone and type selector', () => {
    render(<EntryUpload scope="global" />);
    expect(screen.getByRole('button', { name: /选择或拖拽文件上传/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '自动' })).toBeInTheDocument();
  });

  it('uploads accepted files and reports accepted + rejected', async () => {
    uploadFiles.mockResolvedValue({
      jobs: [{ job_id: 'job-1', file_name: 'a.txt', status: 'queued' }],
      rejected: []
    });
    const onResult = vi.fn();
    render(<EntryUpload scope="global" onResult={onResult} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [makeFile('a.txt'), makeFile('b.exe')], configurable: true });
    fireEvent.change(input);

    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));
    expect(uploadFiles.mock.calls[0]![0]).toMatchObject({
      scope: 'global',
      files: [expect.objectContaining({ name: 'a.txt' })]
    });
    await waitFor(() => expect(onResult).toHaveBeenCalled());
    const result = onResult.mock.calls[0]![0];
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].jobId).toBe('job-1');
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('不支持');
  });

  it('includes work_id and entry_type when provided', async () => {
    uploadFiles.mockResolvedValue({ jobs: [], rejected: [] });
    render(<EntryUpload scope="work" workId="work-9" />);
    await userEvent.click(screen.getByRole('radio', { name: '论文' }));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [makeFile('a.txt')], configurable: true });
    fireEvent.change(input);

    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));
    expect(uploadFiles.mock.calls[0]![0]).toMatchObject({
      scope: 'work',
      work_id: 'work-9',
      entry_type: 'paper'
    });
  });

  it('does not call the network when all files are locally rejected', async () => {
    render(<EntryUpload scope="global" />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [makeFile('bad.exe')], configurable: true });
    fireEvent.change(input);
    expect(uploadFiles).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('bad.exe'));
  });
});
