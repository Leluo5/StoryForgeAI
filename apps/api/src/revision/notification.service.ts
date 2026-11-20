import { randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import type {
  ListNotificationsQuery,
  ListNotificationsResponse,
  Notification,
  NotificationType
} from '@storyforge/contracts';
import { NotificationEntity } from '../database/notification.entity';

export interface NotificationLinkedObject {
  kind: string;
  id: string;
  label: string;
}

function toNotification(entity: NotificationEntity): Notification {
  return {
    id: entity.id,
    recipient_id: entity.recipient_id,
    type: entity.type as NotificationType,
    linked_object: entity.linked_object as Notification['linked_object'],
    content: entity.content,
    read_at: entity.read_at ? entity.read_at.toISOString() : null,
    created_at: entity.created_at.toISOString()
  };
}

@Injectable()
export class NotificationService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  /**
   * 记录一条通知（对齐技术方案 §4.5）。
   * 4 类触发：mention / assign / task_result / system。
   * linked_object 为 jsonb 快照（非外键依赖），业务对象删除后仍保留可读历史说明。
   */
  async record(
    recipientId: string,
    type: NotificationType,
    linkedObject: NotificationLinkedObject | null,
    content: string
  ): Promise<Notification> {
    const entity = this.dataSource.getRepository(NotificationEntity).create();
    entity.id = randomUUID();
    entity.recipient_id = recipientId;
    entity.type = type;
    entity.linked_object = linkedObject as Record<string, unknown> | null;
    entity.content = content;
    const saved = await this.dataSource.getRepository(NotificationEntity).save(entity);
    return toNotification(saved);
  }

  /** 标记单条已读（幂等：已读直接返回） */
  async markRead(authorId: string, notificationId: string): Promise<{ notification: Notification }> {
    const repository = this.dataSource.getRepository(NotificationEntity);
    const entity = await repository.findOne({
      where: { id: notificationId, recipient_id: authorId }
    });
    if (!entity) throw new NotFoundException('Notification not found');
    if (entity.read_at) return { notification: toNotification(entity) };
    entity.read_at = new Date();
    await repository.save(entity);
    return { notification: toNotification(entity) };
  }

  /** 全部已读：返回更新条数 */
  async markAllRead(authorId: string): Promise<{ updated: number }> {
    const result = await this.dataSource.getRepository(NotificationEntity)
      .createQueryBuilder()
      .update()
      .set({ read_at: new Date() })
      .where('recipient_id = :authorId', { authorId })
      .andWhere('read_at IS NULL')
      .execute();
    return { updated: result.affected ?? 0 };
  }

  /** 未读数 */
  async unreadCount(authorId: string): Promise<{ unread: number }> {
    const unread = await this.dataSource.getRepository(NotificationEntity).count({
      where: { recipient_id: authorId, read_at: IsNull() }
    });
    return { unread };
  }

  /** 我的通知列表：分页 + 未读过滤，按创建时间倒序 */
  async list(authorId: string, query: ListNotificationsQuery): Promise<ListNotificationsResponse> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const qb = this.dataSource.getRepository(NotificationEntity).createQueryBuilder('notification')
      .where('notification.recipient_id = :authorId', { authorId });
    if (query.unread_only) {
      qb.andWhere('notification.read_at IS NULL');
    }
    const [notifications, total] = await qb
      .orderBy('notification.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();
    return {
      notifications: notifications.map(toNotification),
      total,
      page,
      page_size: pageSize
    };
  }
}
