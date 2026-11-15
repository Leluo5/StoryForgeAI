import {
  versionConflictDetailsSchema,
  type Chapter,
  type ProseMirrorNode,
  type SaveChangeRequest,
  type SaveChangeResponse,
  type VersionConflictDetails
} from '@storyforge/contracts';
import { canonicalizeDocument, createEmptyDocument } from '@storyforge/editor-schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { WalStore } from '../persistence/wal';
import { WriteLease } from '../persistence/write-lease';
import { saveChange as defaultSave } from '../works/writing-client';

export type SaveStatus = 'local_saving' | 'local_saved' | 'syncing' | 'synced' | 'offline_pending' | 'conflict' | 'save_failed' | 'recovering' | 'read_only';
export interface WriterLease {
  start(onLost: () => void): Promise<boolean>;
  takeover(onLost: () => void): Promise<boolean>;
  stop(): Promise<void>;
  canWrite(): boolean;
}
export interface WriterConflict {
  baseDocument: ProseMirrorNode;
  baseVersion: number;
  localDocument: ProseMirrorNode;
  serverDocument: ProseMirrorNode;
  serverVersion: number;
  serverContentHash: string;
  requestId: string;
}
interface Options {
  workId: string;
  chapterId: string;
  clientId: string;
  store?: WalStore;
  lease?: WriterLease;
  loadChapter(): Promise<Chapter>;
  saveChange?: (workId: string, chapterId: string, input: SaveChangeRequest) => Promise<SaveChangeResponse>;
}

export function useChapterWriter(options: Options) {
  const { workId, chapterId, clientId } = options;
  const store = useRef(options.store ?? new WalStore());
  const lease = useRef<WriterLease>(options.lease ?? new WriteLease(chapterId, clientId));
  const save = useRef(options.saveChange ?? defaultSave);
  const [chapter, setChapter] = useState<Chapter>();
  const [document, setDocument] = useState<ProseMirrorNode>(createEmptyDocument());
  const [status, setStatus] = useState<SaveStatus>('recovering');
  const [conflict, setConflict] = useState<WriterConflict>();
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const flushing = useRef<Promise<void> | undefined>(undefined);
  const autoSave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ready = useRef(false);

  // 单飞刷新：同一时刻只允许一个同步循环，避免重复 acknowledge 与重复请求
  const flush = useCallback((): Promise<void> => {
    if (flushing.current) return flushing.current;
    const operation = (async () => {
      if (!ready.current || !lease.current.canWrite()) { if (ready.current) setStatus('read_only'); return; }
      let acknowledged = false;
      try {
        for (;;) {
          const pending = await store.current.nextPending(workId, chapterId);
          if (!pending) break;
          if (!lease.current.canWrite()) { setStatus('read_only'); return; }
          setStatus('syncing');
          const response = await save.current(workId, chapterId, {
            change_id: pending.change_id,
            client_id: pending.client_id,
            sequence: pending.sequence,
            base_version: pending.base_version,
            operations: pending.operations
          });
          // 只有服务端确认后才推进本地快照，禁止提前假装保存成功
          await store.current.acknowledge(pending.change_id, response.server_version, response.content_hash);
          setChapter((current) => current ? { ...current, version: response.server_version, content_hash: response.content_hash } : current);
          acknowledged = true;
        }
        if (acknowledged) setStatus('synced');
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const details = versionConflictDetailsSchema.parse(error.details) as VersionConflictDetails;
          const recovered = await store.current.recover(workId, chapterId);
          setConflict({
            baseDocument: recovered.baseDocument,
            baseVersion: recovered.baseVersion,
            localDocument: recovered.document,
            serverDocument: details.server_document,
            serverVersion: details.server_version,
            serverContentHash: details.server_content_hash,
            requestId: error.requestId
          });
          setStatus('conflict');
        } else if (error instanceof ApiError && error.status < 500) {
          setStatus('save_failed');
        } else {
          setStatus('offline_pending');
        }
      }
    })();
    flushing.current = operation;
    void operation.finally(() => { if (flushing.current === operation) flushing.current = undefined; });
    return operation;
  }, [chapterId, workId]);

  useEffect(() => {
    let active = true;
    ready.current = false;
    setStatus('recovering');
    async function initialize() {
      try {
        const server = await options.loadChapter();
        await store.current.initialize(workId, chapterId, server.document, server.version, server.content_hash);
        if (!active) return;
        setChapter(server);
        const acquired = await lease.current.start(() => { ready.current = false; setStatus('read_only'); });
        if (!active) {
          if (acquired) await lease.current.stop();
          return;
        }
        const recovered = await store.current.recover(workId, chapterId);
        if (!active) return;
        setDocument(recovered.document); ready.current = acquired;
        // 本地基准与服务端版本不一致时不做自动 flush，交给人工三方合并
        if (recovered.baseVersion !== server.version) {
          setConflict({
            baseDocument: recovered.baseDocument,
            baseVersion: recovered.baseVersion,
            localDocument: recovered.document,
            serverDocument: server.document,
            serverVersion: server.version,
            serverContentHash: server.content_hash,
            requestId: 'initialization-version-mismatch'
          });
          setStatus('conflict');
          return;
        }
        setStatus(acquired ? (recovered.pending.length ? 'local_saved' : 'synced') : 'read_only');
        if (acquired && recovered.pending.length) await flush();
      } catch { if (active) setStatus('save_failed'); }
    }
    void initialize();
    const hidden = () => { if (window.document.visibilityState === 'hidden') void flush(); };
    window.document.addEventListener('visibilitychange', hidden);
    return () => {
      // 卸载时先把未确认日志刷到服务端，再释放租约
      const finalFlush = ready.current && lease.current.canWrite() ? flush() : Promise.resolve();
      active = false;
      ready.current = false;
      if (autoSave.current) clearTimeout(autoSave.current);
      window.document.removeEventListener('visibilitychange', hidden);
      void finalFlush.finally(() => lease.current.stop());
    };
  }, [chapterId, flush, workId]);

  function append(operations: Array<Record<string, unknown>>, nextDocument: ProseMirrorNode): Promise<void> {
    const task = queue.current.then(async () => {
      if (!ready.current || !lease.current.canWrite()) { setStatus('read_only'); return; }
      setStatus('local_saving');
      try {
        await store.current.append({ workId, chapterId, clientId, operations });
        const recovered = await store.current.recover(workId, chapterId);
        if (canonicalizeDocument(recovered.document) !== canonicalizeDocument(nextDocument)) throw new Error('Recovered document differs from editor');
        setDocument(recovered.document); setStatus('local_saved');
        // 300ms 空闲后才触发云端同步
        if (autoSave.current) clearTimeout(autoSave.current);
        autoSave.current = setTimeout(() => void flush(), 300);
      } catch { setStatus('save_failed'); }
    });
    queue.current = task.catch(() => undefined);
    return task;
  }

  async function resolveConflict(selectedDocument: ProseMirrorNode): Promise<void> {
    if (!conflict) return;
    // 失去租约后不允许把冲突选择写回 WAL，否则会覆盖其他标签的编辑
    if (!ready.current || !lease.current.canWrite()) {
      ready.current = false;
      setStatus('read_only');
      throw new Error('写入租约已失效，不能解决冲突；可先从服务端恢复，再显式接管写入');
    }
    const entry = await store.current.resolveConflict({
      workId, chapterId, clientId,
      baseDocument: conflict.baseDocument, baseVersion: conflict.baseVersion,
      localDocument: conflict.localDocument, serverDocument: conflict.serverDocument,
      serverVersion: conflict.serverVersion, serverContentHash: conflict.serverContentHash,
      selectedDocument
    });
    const recovered = await store.current.recover(workId, chapterId);
    setDocument(recovered.document); setConflict(undefined);
    setChapter((current) => current ? {
      ...current, document: conflict.serverDocument, version: conflict.serverVersion, content_hash: conflict.serverContentHash
    } : current);
    setStatus(entry ? 'local_saved' : 'synced');
    if (entry) await flush();
  }

  async function takeover(): Promise<void> {
    setStatus('recovering');
    try {
      const acquired = await lease.current.takeover(() => { ready.current = false; setStatus('read_only'); });
      ready.current = acquired;
      if (!acquired) { setStatus('read_only'); return; }
      const recovered = await store.current.recover(workId, chapterId);
      setDocument(recovered.document);
      setStatus(recovered.pending.length ? 'local_saved' : 'synced');
      if (recovered.pending.length) await flush();
    } catch {
      ready.current = false;
      setStatus('read_only');
    }
  }

  async function restoreFromServer(): Promise<void> {
    const server: Chapter = conflict ? {
      ...(chapter ?? await options.loadChapter()),
      document: conflict.serverDocument,
      version: conflict.serverVersion,
      content_hash: conflict.serverContentHash
    } : await options.loadChapter();
    await store.current.initialize(workId, chapterId, server.document, server.version, server.content_hash);
    await store.current.restoreFromServer(workId, chapterId, server.document, server.version, server.content_hash);
    const recovered = await store.current.recover(workId, chapterId);
    ready.current = lease.current.canWrite();
    setDocument(recovered.document); setConflict(undefined); setChapter(server);
    setStatus(ready.current ? 'synced' : 'read_only');
  }

  return {
    chapter, document, status, conflict,
    readOnly: status === 'recovering' || status === 'read_only',
    append, flush, takeover, resolveConflict, restoreFromServer,
    saveMarkdownDraft: (source: string) => store.current.saveMarkdown(chapterId, source),
    exportRecovery: () => store.current.exportChapter(workId, chapterId)
  };
}
