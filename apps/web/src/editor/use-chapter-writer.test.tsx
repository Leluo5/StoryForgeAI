import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { applyOperations, canonicalizeContent, createEmptyDocument, schema } from '@storyforge/editor-schema';
import type { Chapter, SaveChangeRequest } from '@storyforge/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { WalStore } from '../persistence/wal';
import { useChapterWriter, type WriterLease } from './use-chapter-writer';

// restoreMocks 会在每个用例前清空 mock 实现，因此租约必须在用例内创建
const createLease = (): WriterLease => ({
  start: vi.fn().mockResolvedValue(true),
  takeover: vi.fn().mockResolvedValue(true),
  stop: vi.fn().mockResolvedValue(undefined),
  canWrite: () => true
});
const insert = new ReplaceStep(1, 1, new Slice(Fragment.from(schema.text('你')), 0, 0)).toJSON();
const document = applyOperations(createEmptyDocument(), [insert]).toJSON();
const digest = (value: unknown) => createHash('sha256').update(canonicalizeContent(value)).digest('hex');

function options(save: (input: SaveChangeRequest) => Promise<{ change_id: string; server_version: number; content_hash: string }>) {
  const workId = crypto.randomUUID();
  const chapterId = crypto.randomUUID();
  const chapter: Chapter = {
    id: chapterId, work_id: workId, volume_id: crypto.randomUUID(), title: '第一章', position: 0,
    version: 0, content_hash: digest(createEmptyDocument()), document: createEmptyDocument()
  };
  const store = new WalStore();
  return {
    chapter, workId, chapterId, clientId: crypto.randomUUID(), store, lease: createLease(),
    loadChapter: vi.fn().mockResolvedValue(chapter),
    saveChange: vi.fn().mockImplementation((_workId: string, _chapterId: string, input: SaveChangeRequest) => save(input))
  };
}

describe('useChapterWriter', () => {
  it('acknowledges only after the server response', async () => {
    const config = options(async (input) => ({ change_id: input.change_id, server_version: 1, content_hash: digest(document) }));
    const acknowledge = vi.spyOn(config.store, 'acknowledge');
    const { result } = renderHook(() => useChapterWriter(config));
    await waitFor(() => expect(result.current.status).toBe('synced'));
    await act(() => result.current.append([insert], document));
    expect(result.current.status).toBe('local_saved');
    expect(acknowledge).not.toHaveBeenCalled();
    await act(() => result.current.flush());
    expect(acknowledge).toHaveBeenCalledWith(expect.any(String), 1, digest(document));
    expect(result.current.status).toBe('synced');
  });

  it('flushes pending changes before releasing the lease on unmount', async () => {
    const localLease: WriterLease = {
      start: vi.fn().mockResolvedValue(true),
      takeover: vi.fn().mockResolvedValue(true),
      stop: vi.fn().mockResolvedValue(undefined),
      canWrite: () => true
    };
    const config = {
      ...options(async (input) => ({ change_id: input.change_id, server_version: 1, content_hash: digest(document) })),
      lease: localLease
    };
    const acknowledge = vi.spyOn(config.store, 'acknowledge');
    const { result, unmount } = renderHook(() => useChapterWriter(config));
    await waitFor(() => expect(result.current.status).toBe('synced'));
    await act(() => result.current.append([insert], document));
    unmount();
    await waitFor(() => expect(localLease.stop).toHaveBeenCalledTimes(1));
    expect(acknowledge).toHaveBeenCalledWith(expect.any(String), 1, digest(document));
    expect(acknowledge.mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(localLease.stop).mock.invocationCallOrder[0]!
    );
  });

  it('starts heartbeats and resumes pending writes only after an explicit takeover', async () => {
    let held = false;
    const localLease: WriterLease = {
      start: vi.fn().mockImplementation(async () => false),
      takeover: vi.fn().mockImplementation(async () => { held = true; return true; }),
      stop: vi.fn().mockResolvedValue(undefined),
      canWrite: () => held
    };
    const config = {
      ...options(async (input) => ({ change_id: input.change_id, server_version: 1, content_hash: digest(document) })),
      lease: localLease
    };
    const { result } = renderHook(() => useChapterWriter(config));
    await waitFor(() => expect(result.current.status).toBe('read_only'));
    await act(() => result.current.takeover());
    expect(localLease.takeover).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('synced');
    expect(result.current.readOnly).toBe(false);
  });

  it('keeps pending WAL and exposes base, local and server documents on 409', async () => {
    const serverDocument = applyOperations(createEmptyDocument(), [insert]).toJSON();
    const config = options(async () => { throw new ApiError(409, 'CONFLICT', 'conflict', {
      server_version: 1, server_document: serverDocument, server_content_hash: digest(serverDocument)
    }, 'request-id'); });
    const { result } = renderHook(() => useChapterWriter(config));
    await waitFor(() => expect(result.current.status).toBe('synced'));
    await act(() => result.current.append([insert], document));
    await act(() => result.current.flush());
    expect(result.current.status).toBe('conflict');
    expect(result.current.conflict).toMatchObject({ baseVersion: 0, serverVersion: 1, localDocument: document, serverDocument });
    expect((await config.store.recover(config.workId, config.chapterId)).pending).toHaveLength(1);
  });

  it('opens a three-way conflict instead of flushing when the recovered base version differs from the server', async () => {
    const config = options(async (input) => ({ change_id: input.change_id, server_version: 2, content_hash: digest(document) }));
    await config.store.initialize(
      config.workId,
      config.chapterId,
      config.chapter.document,
      config.chapter.version,
      config.chapter.content_hash
    );
    await config.store.append({ workId: config.workId, chapterId: config.chapterId, clientId: config.clientId, operations: [insert] });
    const serverInsert = new ReplaceStep(1, 1, new Slice(Fragment.from(schema.text('服')), 0, 0)).toJSON();
    const serverDocument = applyOperations(createEmptyDocument(), [serverInsert]).toJSON();
    config.loadChapter.mockResolvedValue({
      ...config.chapter,
      version: 1,
      content_hash: digest(serverDocument),
      document: serverDocument
    });

    const { result } = renderHook(() => useChapterWriter(config));
    await waitFor(() => expect(result.current.status).toBe('conflict'));
    expect(result.current.conflict).toMatchObject({
      baseDocument: createEmptyDocument(),
      baseVersion: 0,
      localDocument: document,
      serverDocument,
      serverVersion: 1,
      requestId: 'initialization-version-mismatch'
    });
    expect(config.saveChange).not.toHaveBeenCalled();
    expect((await config.store.recover(config.workId, config.chapterId)).pending).toHaveLength(1);
  });

  it('restores the complete chapter and re-enables a held lease after local recovery fails', async () => {
    const config = options(async (input) => ({ change_id: input.change_id, server_version: 1, content_hash: digest(document) }));
    const recover = vi.spyOn(config.store, 'recover').mockRejectedValueOnce(new Error('corrupt snapshot'));
    const { result } = renderHook(() => useChapterWriter(config));
    await waitFor(() => expect(result.current.status).toBe('save_failed'));

    await act(() => result.current.restoreFromServer());
    expect(result.current.chapter).toEqual(config.chapter);
    expect(result.current.status).toBe('synced');
    expect(result.current.readOnly).toBe(false);
    expect(recover).toHaveBeenCalledTimes(2);

    await act(() => result.current.append([insert], document));
    expect(result.current.status).toBe('local_saved');
    expect((await config.store.recover(config.workId, config.chapterId)).pending).toHaveLength(1);
  });

  it('does not resolve a conflict into WAL after the writer loses its lease', async () => {
    let held = true;
    const localLease: WriterLease = {
      start: vi.fn().mockImplementation(async () => held),
      takeover: vi.fn().mockImplementation(async () => held),
      stop: vi.fn().mockResolvedValue(undefined),
      canWrite: () => held
    };
    const serverDocument = applyOperations(createEmptyDocument(), [insert]).toJSON();
    const config = {
      ...options(async () => { throw new ApiError(409, 'CONFLICT', 'conflict', {
        server_version: 1, server_document: serverDocument, server_content_hash: digest(serverDocument)
      }, 'request-id'); }),
      lease: localLease
    };
    const { result } = renderHook(() => useChapterWriter(config));
    await waitFor(() => expect(result.current.status).toBe('synced'));
    await act(() => result.current.append([insert], document));
    await act(() => result.current.flush());
    await waitFor(() => expect(result.current.status).toBe('conflict'));
    const resolve = vi.spyOn(config.store, 'resolveConflict');

    held = false;
    await act(async () => {
      await expect(result.current.resolveConflict(document)).rejects.toThrow('写入租约已失效');
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(result.current.status).toBe('read_only');
    expect((await config.store.recover(config.workId, config.chapterId)).pending).toHaveLength(1);
  });
});
