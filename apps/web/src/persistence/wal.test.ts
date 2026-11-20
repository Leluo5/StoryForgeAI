import 'fake-indexeddb/auto';
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { canonicalizeContent, createEmptyDocument, schema } from '@storyforge/editor-schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openWritingDB } from './database';
import { WalError, WalStore } from './wal';
import type { Snapshot } from './types';

let ids: { workId: string; chapterId: string; clientId: string };
let store: WalStore;
const emptyHash = 'a'.repeat(64);

beforeEach(async () => {
  ids = { workId: crypto.randomUUID(), chapterId: crypto.randomUUID(), clientId: crypto.randomUUID() };
  store = new WalStore();
  await store.initialize(ids.workId, ids.chapterId, createEmptyDocument(), 0, emptyHash);
});

function insert(text: string, from: number) {
  return new ReplaceStep(from, from, new Slice(Fragment.from(schema.text(text)), 0, 0)).toJSON();
}
async function hash(document: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalizeContent(document)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('WalStore', () => {
  it('advances only the acknowledged boundary and retains later pending entries', async () => {
    const first = await store.append({ ...ids, operations: [insert('你', 1)] });
    const second = await store.append({ ...ids, operations: [insert('好', 2)] });
    expect([first.base_version, second.base_version]).toEqual([0, 1]);
    expect((await store.recover(ids.workId, ids.chapterId)).document).toMatchObject({
      content: [{ content: [{ text: '你好' }] }]
    });
    const firstDocument = (await store.recover(ids.workId, ids.chapterId)).baseDocument;
    const acknowledgedDocument = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '你' }] }] };
    await store.acknowledge(first.change_id, 1, await hash(acknowledgedDocument));
    expect(firstDocument.type).toBe('doc');
    const recovered = await store.recover(ids.workId, ids.chapterId);
    expect(recovered.baseVersion).toBe(1);
    expect(recovered.pending.map((entry) => entry.change_id)).toEqual([second.change_id]);
    expect(recovered.document).toMatchObject({ content: [{ content: [{ text: '你好' }] }] });
    await store.acknowledge(first.change_id, 1, await hash(acknowledgedDocument));
    expect((await store.recover(ids.workId, ids.chapterId)).pending).toHaveLength(1);
  });

  it('backs up base, local, server and raw pending data before conflict resolution', async () => {
    await store.append({ ...ids, operations: [insert('本地', 1)] });
    const local = (await store.recover(ids.workId, ids.chapterId)).document;
    const server = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '服务端' }] }] };
    const entry = await store.resolveConflict({
      ...ids,
      baseDocument: createEmptyDocument(), baseVersion: 0, localDocument: local,
      serverDocument: server, serverVersion: 2, serverContentHash: await hash(server), selectedDocument: local
    });
    expect(entry?.base_version).toBe(2);
    const db = await openWritingDB();
    const backups = (await db.getAll('conflicts')).filter((item) => item.chapter_id === ids.chapterId);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ base_version: 0, server_version: 2 });
    expect(backups[0]?.pending).toHaveLength(1);
    expect((await store.recover(ids.workId, ids.chapterId)).pending).toHaveLength(1);
    expect(JSON.parse(await store.exportChapter(ids.workId, ids.chapterId)).changes).toHaveLength(1);
  });

  it('persists Markdown and classifies quota and corruption without deleting data', async () => {
    await store.saveMarkdown(ids.chapterId, '# 草稿');
    expect(await store.readMarkdown(ids.chapterId)).toBe('# 草稿');
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    await expect(store.append({ ...ids, operations: [insert('失败', 1)] })).rejects.toMatchObject({ kind: 'quota' });
    const db = await openWritingDB();
    const snapshot = await db.get('snapshots', [ids.workId, ids.chapterId]);
    await db.put('snapshots', { ...snapshot!, document: { type: 'paragraph' } } as Snapshot);
    await expect(store.recover(ids.workId, ids.chapterId)).rejects.toBeInstanceOf(WalError);
    expect(await db.get('snapshots', [ids.workId, ids.chapterId])).toBeDefined();
  });
});
