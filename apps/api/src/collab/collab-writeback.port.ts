import type { CollabCitation, CollabRoleField } from '@storyforge/contracts';
import type { EntityManager } from 'typeorm';

// F11 写回端口：任务处理器只依赖端口，不感知写回服务实现（F2 §5.1）
// T13 处理器编排时通过本端口调用写回；T14 提供具体实现（事务写回 + 版本号 + 字段行 + 归档 outbox）。
// 写回由调用方在事务内发起（handler 用 dataSource.transaction 包裹），保证"任一校验失败不产生部分写回"（F2 §1.1 第6条）。

export interface WritebackRecordInput {
  taskId: string;
  workId: string;
  characterId: string;
  channel: 'flowise' | 'coze';
  appliedBy: string;
  /** 已校验通过的字段值（key → 新值），写回目标来自 DB 白名单（可为子集，不要求全字段） */
  fields: Partial<Record<CollabRoleField, string>>;
  /** 引用快照（供归档载荷，不含正文与剧情树） */
  citations: CollabCitation[];
  /** 通道原始结果文本（供归档载荷，不含凭据） */
  resultText: string;
}

export interface WritebackRecord {
  writebackId: string;
  appliedVersion: number;
}

export interface CollabWritebackPort {
  /**
   * 在给定 EntityManager（调用方已开启的事务）内完成写回：
   * 锁角色行 → 复查设置与白名单 → 幂等检查 → 记录 before_value → 更新字段 + version+1 →
   * 写写回单 + 字段行 → 写归档 outbox。返回写回单 id 与写回后版本。
   * 重复写回（同 task_id 已存在）幂等返回既有写回单结果，不新增行。
   */
  applyWriteback(manager: EntityManager, input: WritebackRecordInput): Promise<WritebackRecord>;
}

// Nest DI token：任务处理器注入本端口，T14 提供具体实现（写回服务）
export const COLLAB_WRITEBACK_PORT = Symbol('COLLAB_WRITEBACK_PORT');
