import type { ProseMirrorNode } from '@storyforge/contracts';

export interface Snapshot {
  work_id: string;
  chapter_id: string;
  document: ProseMirrorNode;
  server_version: number;
  content_hash: string;
}
export interface WalEntry {
  change_id: string;
  work_id: string;
  chapter_id: string;
  client_id: string;
  sequence: number;
  base_version: number;
  operations: Array<Record<string, unknown>>;
  created_at: string;
  sync_state: 'pending';
}
export interface SequenceRecord { chapter_id: string; client_id: string; sequence: number }
export interface MarkdownRecord { chapter_id: string; source: string; updated_at: string }
export interface ConflictBackup {
  id: string;
  work_id: string;
  chapter_id: string;
  base_document: ProseMirrorNode;
  base_version: number;
  local_document: ProseMirrorNode;
  server_document: ProseMirrorNode;
  server_version: number;
  pending: WalEntry[];
  created_at: string;
}
export interface LeaseRecord {
  chapter_id: string;
  owner_id: string;
  fencing_token: number;
  expires_at: number;
}
export interface Recovery {
  document: ProseMirrorNode;
  baseDocument: ProseMirrorNode;
  baseVersion: number;
  pending: WalEntry[];
}
export interface ConflictResolution {
  workId: string;
  chapterId: string;
  clientId: string;
  baseDocument: ProseMirrorNode;
  baseVersion: number;
  localDocument: ProseMirrorNode;
  serverDocument: ProseMirrorNode;
  serverVersion: number;
  serverContentHash: string;
  selectedDocument: ProseMirrorNode;
}
