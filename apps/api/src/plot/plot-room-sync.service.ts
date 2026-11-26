import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { PlotNode, SyncRoomAction, SyncRoomInput } from '@storyforge/contracts';
import { syncRoomActionSchema } from '@storyforge/contracts';
import type { EntityManager } from 'typeorm';
import { DataSource } from 'typeorm';
import { ChatRoomService } from '../chat-room/chat-room.service';
import { PlotTreeService } from './plot-tree.service';

export interface PushRoomResult {
  context_nodes: PlotNode[];
  injected: number;
}

export interface PullRoomResult {
  new_nodes: PlotNode[];
  added: number;
  skipped: string[];
}

/**
 * M4-T3 剧情树 ↔ F6 聊天室房间双向联动（迁移自旧 modules/plot/routes.py §3.9 sync_room）。
 * push：把指定节点注入房间 context；pull：把房间已提交推衍步骤回写为剧情节点（origin 全标记去重）。
 */
@Injectable()
export class PlotRoomSyncService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(PlotTreeService) private readonly treeService: PlotTreeService,
    @Inject(ChatRoomService) private readonly chatRoom: ChatRoomService
  ) {}

  /** 路由分发：非法 action 抛 400（对齐旧「联动动作非法，允许：push / pull」） */
  async syncRoom(
    authorId: string,
    workId: string,
    treeId: string,
    roomId: string,
    input: SyncRoomInput
  ): Promise<PushRoomResult | PullRoomResult> {
    if (!syncRoomActionSchema.safeParse(input.action).success) {
      throw new BadRequestException('联动动作非法，允许：push / pull');
    }
    return this.dataSource.transaction(async (tx) => {
      const action = input.action as SyncRoomAction;
      if (action === 'push') return this.push(tx, authorId, workId, treeId, roomId, input);
      return this.pull(tx, authorId, workId, treeId, roomId, input);
    });
  }

  /** push：读 context_node_ids 节点（校验存在）→ 注入房间 context → 返回节点视图 */
  private async push(
    tx: EntityManager,
    authorId: string,
    workId: string,
    treeId: string,
    roomId: string,
    input: SyncRoomInput
  ): Promise<PushRoomResult> {
    const tree = await this.treeService.assertTreeOwned(tx, authorId, workId, treeId);
    const contextIds = input.context_node_ids ?? [];
    const nodes = await this.treeService.getNodesByIds(tx, tree.id, contextIds);
    if (nodes.length !== contextIds.length) {
      throw new ConflictException('上下文节点不存在');
    }
    await this.chatRoom.updateContext(tx, authorId, workId, roomId, contextIds);
    return { context_nodes: nodes, injected: nodes.length };
  }

  /** pull：读房间 history（仅房间创建后的步骤）→ 转回写步骤 → 按 origin 全标记去重回写 */
  private async pull(
    tx: EntityManager,
    authorId: string,
    workId: string,
    treeId: string,
    roomId: string,
    input: SyncRoomInput
  ): Promise<PullRoomResult> {
    const tree = await this.treeService.assertTreeOwned(tx, authorId, workId, treeId);
    const [history, roomCreatedAt] = await Promise.all([
      this.chatRoom.getHistory(tx, authorId, workId, roomId),
      this.chatRoom.getCreatedAt(tx, authorId, workId, roomId)
    ]);
    // 仅回写房间创建后的步骤：规避 history 清空重建（step_index 归零）后 step_no 复用误判
    const steps = history
      .filter((h) => !h.created_at || new Date(h.created_at as string) >= roomCreatedAt)
      .map((h) => {
        const stepNo = String(h.step_no ?? 0);
        const content = typeof h.content === 'string' ? h.content : '';
        return {
          syncRoomOrigin: `sync-room:${roomId}:${stepNo}`,
          title: typeof h.label === 'string' && h.label ? h.label : `推衍第${stepNo}步`,
          content
        };
      });
    const { created, skipped } = await this.treeService.batchCreateSyncNodes(tx, authorId, workId, {
      parentNodeId: input.parent_node_id ?? null,
      nodes: steps
    });
    return { new_nodes: created, added: created.length, skipped };
  }
}
