import type { ProseMirrorNode } from '@storyforge/contracts';
import {
  applyOperations,
  canonicalizeContent,
  parseDocument,
  replaceDocumentOperations
} from '@storyforge/editor-schema';
import { openWritingDB } from './database';
import type { ConflictResolution, Recovery, Snapshot, WalEntry } from './types';

export class WalError extends Error {
  constructor(public readonly kind: 'quota' | 'corrupt' | 'unknown', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WalError';
  }
}
export function toWalError(error: unknown): WalError {
  if (error instanceof WalError) return error;
  if (error instanceof DOMException && ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'].includes(error.name)) {
    return new WalError('quota', 'IndexedDB storage quota exceeded', { cause: error });
  }
  if (error instanceof Error && /document|ProseMirror|step|snapshot|JSON|Schema|node/i.test(error.message)) {
    return new WalError('corrupt', 'Local writing data is corrupt', { cause: error });
  }
  return new WalError('unknown', 'IndexedDB writing operation failed', { cause: error });
}
function sortPending(entries: WalEntry[]): WalEntry[] {
  return entries.sort((left, right) => left.base_version - right.base_version
    || left.client_id.localeCompare(right.client_id) || left.sequence - right.sequence);
}
async function sha256(document: unknown): Promise<string> {
  // 与服务端 content_hash 口径一致：忽略 pid
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalizeContent(document)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function run<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { throw toWalError(error); }
}

export class WalStore {
  initialize(workId: string, chapterId: string, document: unknown, serverVersion: number, contentHash: string): Promise<void> {
    return run(async () => {
      const db = await openWritingDB();
      const key: [string, string] = [workId, chapterId];
      const existing = await db.get('snapshots', key);
      if (!existing) {
        await db.put('snapshots', {
          work_id: workId,
          chapter_id: chapterId,
          document: parseDocument(document).toJSON() as ProseMirrorNode,
          server_version: serverVersion,
          content_hash: contentHash
        });
      }
    });
  }

  append(input: { workId: string; chapterId: string; clientId: string; operations: Array<Record<string, unknown>> }): Promise<WalEntry> {
    return run(async () => {
      const db = await openWritingDB();
      const tx = db.transaction(['snapshots', 'changes', 'sequences'], 'readwrite');
      const snapshot = await tx.objectStore('snapshots').get([input.workId, input.chapterId]);
      if (!snapshot) throw new Error('Snapshot not found');
      const pending = sortPending(await tx.objectStore('changes').index('by-chapter').getAll([input.workId, input.chapterId]));
      const previous = await tx.objectStore('sequences').get([input.chapterId, input.clientId]);
      const last = pending.at(-1);
      const entry: WalEntry = {
        change_id: crypto.randomUUID(),
        work_id: input.workId,
        chapter_id: input.chapterId,
        client_id: input.clientId,
        sequence: (previous?.sequence ?? 0) + 1,
        base_version: last ? last.base_version + 1 : snapshot.server_version,
        operations: input.operations,
        created_at: new Date().toISOString(),
        sync_state: 'pending'
      };
      const base = applyOperations(
        snapshot.document,
        pending.flatMap((item) => item.operations)
      ).toJSON();
      applyOperations(base, entry.operations);
      await tx.objectStore('changes').add(entry);
      await tx.objectStore('sequences').put({ chapter_id: input.chapterId, client_id: input.clientId, sequence: entry.sequence });
      await tx.done;
      return entry;
    });
  }

  recover(workId: string, chapterId: string): Promise<Recovery> {
    return run(async () => {
      const db = await openWritingDB();
      const snapshot = await db.get('snapshots', [workId, chapterId]);
      if (!snapshot) throw new Error('Snapshot not found');
      const pending = sortPending(await db.getAllFromIndex('changes', 'by-chapter', [workId, chapterId]));
      const document = applyOperations(snapshot.document, pending.flatMap((entry) => entry.operations));
      return {
        document: document.toJSON() as ProseMirrorNode,
        baseDocument: parseDocument(snapshot.document).toJSON() as ProseMirrorNode,
        baseVersion: snapshot.server_version,
        pending
      };
    });
  }

  nextPending(workId: string, chapterId: string): Promise<WalEntry | undefined> {
    return run(async () => {
      const db = await openWritingDB();
      return sortPending(await db.getAllFromIndex('changes', 'by-chapter', [workId, chapterId]))[0];
    });
  }

  acknowledge(changeId: string, serverVersion: number, contentHash: string): Promise<void> {
    return run(async () => {
      const db = await openWritingDB();
      const existing = await db.get('changes', changeId);
      if (!existing) return;
      const existingSnapshot = await db.get('snapshots', [existing.work_id, existing.chapter_id]);
      if (!existingSnapshot) throw new Error('Snapshot not found');
      const existingPending = sortPending(
        await db.getAllFromIndex('changes', 'by-chapter', [existing.work_id, existing.chapter_id])
      );
      if (existingPending[0]?.change_id !== changeId) {
        throw new Error('Cannot acknowledge beyond the contiguous WAL boundary');
      }
      if (serverVersion !== existingSnapshot.server_version + 1 || existing.base_version !== existingSnapshot.server_version) {
        throw new Error('Snapshot version does not match acknowledged change');
      }
      const document = applyOperations(existingSnapshot.document, existing.operations).toJSON();
      if (await sha256(document) !== contentHash) throw new Error('Acknowledged content hash does not match WAL');

      const tx = db.transaction(['snapshots', 'changes'], 'readwrite');
      const current = await tx.objectStore('changes').get(changeId);
      if (!current) { await tx.done; return; }
      const snapshot = await tx.objectStore('snapshots').get([current.work_id, current.chapter_id]);
      if (!snapshot) throw new Error('Snapshot not found');
      const pending = sortPending(
        await tx.objectStore('changes').index('by-chapter').getAll([current.work_id, current.chapter_id])
      );
      if (pending[0]?.change_id !== changeId) {
        throw new Error('Cannot acknowledge beyond the contiguous WAL boundary');
      }
      if (serverVersion !== snapshot.server_version + 1 || current.base_version !== snapshot.server_version) {
        throw new Error('Snapshot version does not match acknowledged change');
      }
      const currentDocument = applyOperations(snapshot.document, current.operations).toJSON();
      if (canonicalizeContent(currentDocument) !== canonicalizeContent(document)) {
        throw new Error('WAL changed while the acknowledgement hash was computed');
      }
      const nextSnapshot: Snapshot = {
        ...snapshot,
        document: currentDocument as ProseMirrorNode,
        server_version: serverVersion,
        content_hash: contentHash
      };
      await tx.objectStore('snapshots').put(nextSnapshot);
      await tx.objectStore('changes').delete(changeId);
      await tx.done;
    });
  }

  saveMarkdown(chapterId: string, source: string): Promise<void> {
    return run(async () => {
      const db = await openWritingDB();
      await db.put('markdown', { chapter_id: chapterId, source, updated_at: new Date().toISOString() });
    });
  }
  readMarkdown(chapterId: string): Promise<string | undefined> {
    return run(async () => (await (await openWritingDB()).get('markdown', chapterId))?.source);
  }

  resolveConflict(input: ConflictResolution): Promise<WalEntry | undefined> {
    return run(async () => {
      const db = await openWritingDB();
      const snapshot = await db.get('snapshots', [input.workId, input.chapterId]);
      if (!snapshot) throw new Error('Snapshot not found');
      const pending = sortPending(await db.getAllFromIndex('changes', 'by-chapter', [input.workId, input.chapterId]));
      await db.put('conflicts', {
        id: crypto.randomUUID(), work_id: input.workId, chapter_id: input.chapterId,
        base_document: input.baseDocument, base_version: input.baseVersion,
        local_document: input.localDocument, server_document: input.serverDocument,
        server_version: input.serverVersion, pending, created_at: new Date().toISOString()
      });
      const tx = db.transaction(['snapshots', 'changes', 'sequences'], 'readwrite');
      for (const entry of pending) await tx.objectStore('changes').delete(entry.change_id);
      await tx.objectStore('snapshots').put({
        ...snapshot,
        document: parseDocument(input.serverDocument).toJSON() as ProseMirrorNode,
        server_version: input.serverVersion,
        content_hash: input.serverContentHash
      });
      let entry: WalEntry | undefined;
      if (canonicalizeContent(input.selectedDocument) !== canonicalizeContent(input.serverDocument)) {
        const previous = await tx.objectStore('sequences').get([input.chapterId, input.clientId]);
        entry = {
          change_id: crypto.randomUUID(), work_id: input.workId, chapter_id: input.chapterId,
          client_id: input.clientId, sequence: (previous?.sequence ?? 0) + 1,
          base_version: input.serverVersion,
          operations: replaceDocumentOperations(input.serverDocument, input.selectedDocument),
          created_at: new Date().toISOString(), sync_state: 'pending'
        };
        await tx.objectStore('changes').add(entry);
        await tx.objectStore('sequences').put({ chapter_id: input.chapterId, client_id: input.clientId, sequence: entry.sequence });
      }
      await tx.done;
      return entry;
    });
  }

  restoreFromServer(workId: string, chapterId: string, serverDocument: ProseMirrorNode, serverVersion: number, serverContentHash: string): Promise<void> {
    return run(async () => {
      const db = await openWritingDB();
      const snapshot = await db.get('snapshots', [workId, chapterId]);
      if (!snapshot) throw new Error('Snapshot not found');
      const pending = sortPending(await db.getAllFromIndex('changes', 'by-chapter', [workId, chapterId]));
      let local = snapshot.document;
      try { local = applyOperations(snapshot.document, pending.flatMap((entry) => entry.operations)).toJSON() as ProseMirrorNode; }
      catch { local = snapshot.document; }
      await db.put('conflicts', {
        id: crypto.randomUUID(), work_id: workId, chapter_id: chapterId,
        base_document: snapshot.document, base_version: snapshot.server_version,
        local_document: local, server_document: serverDocument, server_version: serverVersion,
        pending, created_at: new Date().toISOString()
      });
      const tx = db.transaction(['snapshots', 'changes'], 'readwrite');
      for (const entry of pending) await tx.objectStore('changes').delete(entry.change_id);
      await tx.objectStore('snapshots').put({ ...snapshot, document: serverDocument, server_version: serverVersion, content_hash: serverContentHash });
      await tx.done;
    });
  }

  exportChapter(workId: string, chapterId: string): Promise<string> {
    return run(async () => {
      const db = await openWritingDB();
      const snapshot = await db.get('snapshots', [workId, chapterId]);
      const changes = sortPending(await db.getAllFromIndex('changes', 'by-chapter', [workId, chapterId]));
      const markdown = await db.get('markdown', chapterId);
      const conflicts = (await db.getAll('conflicts')).filter((item) => item.work_id === workId && item.chapter_id === chapterId);
      return JSON.stringify({ format: 'storyforge-wal-v1', exported_at: new Date().toISOString(), snapshot, changes, markdown, conflicts }, null, 2);
    });
  }
}
