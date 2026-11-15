import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ConflictBackup, LeaseRecord, MarkdownRecord, SequenceRecord, Snapshot, WalEntry } from './types';

export interface WritingDB extends DBSchema {
  snapshots: { key: [string, string]; value: Snapshot };
  changes: { key: string; value: WalEntry; indexes: { 'by-chapter': [string, string] } };
  sequences: { key: [string, string]; value: SequenceRecord };
  markdown: { key: string; value: MarkdownRecord };
  conflicts: { key: string; value: ConflictBackup };
  leases: { key: string; value: LeaseRecord };
}

let database: Promise<IDBPDatabase<WritingDB>> | undefined;
export function openWritingDB(): Promise<IDBPDatabase<WritingDB>> {
  database ??= openDB<WritingDB>('storyforge-writing', 1, {
    upgrade(db) {
      db.createObjectStore('snapshots', { keyPath: ['work_id', 'chapter_id'] });
      const changes = db.createObjectStore('changes', { keyPath: 'change_id' });
      changes.createIndex('by-chapter', ['work_id', 'chapter_id']);
      db.createObjectStore('sequences', { keyPath: ['chapter_id', 'client_id'] });
      db.createObjectStore('markdown', { keyPath: 'chapter_id' });
      db.createObjectStore('conflicts', { keyPath: 'id' });
      db.createObjectStore('leases', { keyPath: 'chapter_id' });
    }
  });
  return database;
}
