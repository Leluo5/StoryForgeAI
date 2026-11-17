import { randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type {
  CreateTodoRequest,
  ListTodosQuery,
  ListTodosResponse,
  Todo,
  TodoStatus
} from '@storyforge/contracts';
import { TodoEntity } from '../database/todo.entity';
import { WorkEntity } from '../database/work.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { CommentThreadEntity } from '../database/comment-thread.entity';
import { RevisionSetEntity } from '../database/revision-set.entity';
import { NotificationEntity } from '../database/notification.entity';
import { AuditService } from './audit.service';

/**
 * 状态机约束（对齐技术方案 §4.4）：
 * open → in_progress → done；cancelled 终态。
 * 非法流转抛 422；重复完成保持 done，单次审计语义。
 */
const TRANSITIONS: Record<TodoStatus, TodoStatus[]> = {
  open: ['in_progress', 'done', 'cancelled'],
  in_progress: ['done', 'cancelled'],
  done: [],
  cancelled: []
};

function toTodo(entity: TodoEntity): Todo {
  return {
    id: entity.id,
    work_id: entity.work_id,
    chapter_id: entity.chapter_id,
    comment_id: entity.comment_id,
    revision_set_id: entity.revision_set_id,
    title: entity.title,
    description: entity.description,
    assignee_id: entity.assignee_id,
    status: entity.status as TodoStatus,
    created_at: entity.created_at.toISOString(),
    updated_at: entity.updated_at.toISOString()
  };
}

/** 校验作品归属（作者本人），并可选加悲观锁 */
async function assertOwnedWork(manager: EntityManager, workId: string, authorId: string, lock = false): Promise<WorkEntity> {
  const qb = manager.getRepository(WorkEntity).createQueryBuilder('work')
    .where('work.id = :workId', { workId })
    .andWhere('work.author_id = :authorId', { authorId });
  if (lock) qb.setLock('pessimistic_write');
  const work = await qb.getOne();
  if (!work) throw new NotFoundException('Work not found');
  return work;
}

/** 校验待办归属（作品内 + 作者本人） */
async function assertOwnedTodo(manager: EntityManager, workId: string, todoId: string, authorId: string, lock = false): Promise<TodoEntity> {
  const qb = manager.getRepository(TodoEntity).createQueryBuilder('todo')
    .innerJoin(WorkEntity, 'work', 'work.id = todo.work_id')
    .where('todo.id = :todoId', { todoId })
    .andWhere('todo.work_id = :workId', { workId })
    .andWhere('work.author_id = :authorId', { authorId });
  if (lock) qb.setLock('pessimistic_write');
  const todo = await qb.getOne();
  if (!todo) throw new NotFoundException('Todo not found');
  return todo;
}

/** 校验评论线程归属（作品内 + 作者本人） */
async function assertOwnedComment(manager: EntityManager, workId: string, commentId: string, authorId: string): Promise<CommentThreadEntity> {
  const comment = await manager.getRepository(CommentThreadEntity).createQueryBuilder('comment')
    .innerJoin(ChapterEntity, 'chapter', 'chapter.id = comment.chapter_id')
    .innerJoin(WorkEntity, 'work', 'work.id = chapter.work_id')
    .where('comment.id = :commentId', { commentId })
    .andWhere('chapter.work_id = :workId', { workId })
    .andWhere('work.author_id = :authorId', { authorId })
    .getOne();
  if (!comment) throw new NotFoundException('Comment thread not found');
  return comment;
}

/** 校验关联对象存在（chapter / revision_set，存在性校验，不做归属校验——由外层 work 归属兜底） */
async function assertLinkedReference(manager: EntityManager, workId: string, kind: 'chapter' | 'revision_set', refId: string): Promise<void> {
  if (kind === 'chapter') {
    const exists = await manager.getRepository(ChapterEntity).createQueryBuilder('chapter')
      .innerJoin(WorkEntity, 'work', 'work.id = chapter.work_id')
      .where('chapter.id = :refId', { refId })
      .andWhere('chapter.work_id = :workId', { workId })
      .getExists();
    if (!exists) throw new NotFoundException('Linked chapter not found');
  } else {
    const exists = await manager.getRepository(RevisionSetEntity).createQueryBuilder('revision')
      .innerJoin(ChapterEntity, 'chapter', 'chapter.id = revision.chapter_id')
      .innerJoin(WorkEntity, 'work', 'work.id = chapter.work_id')
      .where('revision.id = :refId', { refId })
      .andWhere('chapter.work_id = :workId', { workId })
      .getExists();
    if (!exists) throw new NotFoundException('Linked revision set not found');
  }
}

/** 写一条通知（供本服务内部触发 assign / task_result） */
async function writeNotification(
  manager: EntityManager,
  recipientId: string,
  type: 'assign' | 'task_result',
  linkedObject: { kind: string; id: string; label: string },
  content: string
): Promise<void> {
  const entity = manager.getRepository(NotificationEntity).create();
  entity.id = randomUUID();
  entity.recipient_id = recipientId;
  entity.type = type;
  entity.linked_object = linkedObject;
  entity.content = content;
  await manager.save(entity);
}

@Injectable()
export class TodoService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  /** 创建待办：标题/说明/负责人/关联对象；负责人有值产生 assign 通知 + 审计 */
  createTodo(authorId: string, workId: string, input: CreateTodoRequest): Promise<{ todo: Todo }> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedWork(manager, workId, authorId, true);
      if (input.chapter_id) await assertLinkedReference(manager, workId, 'chapter', input.chapter_id);
      if (input.revision_set_id) await assertLinkedReference(manager, workId, 'revision_set', input.revision_set_id);
      if (input.comment_id) await assertOwnedComment(manager, workId, input.comment_id, authorId);

      const entity = manager.getRepository(TodoEntity).create();
      entity.id = randomUUID();
      entity.work_id = workId;
      entity.chapter_id = input.chapter_id ?? null;
      entity.comment_id = input.comment_id ?? null;
      entity.revision_set_id = input.revision_set_id ?? null;
      entity.title = input.title;
      entity.description = input.description ?? null;
      entity.assignee_id = input.assignee_id ?? null;
      entity.status = 'open';
      await manager.save(entity);

      await this.auditService.record(authorId, 'todo_create', 'todo', entity.id, {
        title: entity.title,
        assignee_id: entity.assignee_id
      }, workId);

      if (entity.assignee_id) {
        await writeNotification(
          manager,
          entity.assignee_id,
          'assign',
          { kind: 'todo', id: entity.id, label: entity.title },
          `你被指派了待办「${entity.title}」`
        );
      }
      return { todo: toTodo(entity) };
    });
  }

  /** 状态流转：校验状态机，非法 422；状态变化产生通知 + 审计（重复完成单次审计） */
  updateStatus(authorId: string, workId: string, todoId: string, next: TodoStatus): Promise<{ todo: Todo }> {
    return this.dataSource.transaction(async (manager) => {
      const todo = await assertOwnedTodo(manager, workId, todoId, authorId, true);
      const current = todo.status as TodoStatus;

      // 重复完成：保持最终状态，只记录一次审计语义（当前已是 done 且目标 done → 直接返回）
      if (current === next) {
        // 重复完成保持最终状态（done），不重复审计；其余同状态重复调用也幂等返回
        return { todo: toTodo(todo) };
      }

      const allowed = TRANSITIONS[current] ?? [];
      if (!allowed.includes(next)) {
        throw new UnprocessableEntityException({
          message: `Invalid todo status transition: ${current} → ${next}`
        });
      }

      todo.status = next;
      await manager.save(todo);

      await this.auditService.record(authorId, 'todo_status', 'todo', todoId, {
        from: current,
        to: next
      }, workId);

      // 状态变化通知（task_result）：仅通知负责人（如有），否则不产生通知
      if (todo.assignee_id) {
        await writeNotification(
          manager,
          todo.assignee_id,
          'task_result',
          { kind: 'todo', id: todo.id, label: todo.title },
          `待办「${todo.title}」状态更新为 ${next}`
        );
      }
      return { todo: toTodo(todo) };
    });
  }

  /** 评论转待办：以评论内容生成待办，关联 comment_id */
  commentToTodo(authorId: string, workId: string, commentId: string, input: CreateTodoRequest): Promise<{ todo: Todo }> {
    return this.dataSource.transaction(async (manager) => {
      const comment = await assertOwnedComment(manager, workId, commentId, authorId);
      await assertOwnedWork(manager, workId, authorId, true);

      const entity = manager.getRepository(TodoEntity).create();
      entity.id = randomUUID();
      entity.work_id = workId;
      entity.chapter_id = comment.chapter_id;
      entity.comment_id = commentId;
      entity.revision_set_id = input.revision_set_id ?? null;
      entity.title = input.title;
      entity.description = input.description ?? comment.content;
      entity.assignee_id = input.assignee_id ?? null;
      entity.status = 'open';
      await manager.save(entity);

      await this.auditService.record(authorId, 'todo_create', 'todo', entity.id, {
        title: entity.title,
        from_comment: commentId
      }, workId);

      if (entity.assignee_id) {
        await writeNotification(
          manager,
          entity.assignee_id,
          'assign',
          { kind: 'todo', id: entity.id, label: entity.title },
          `你被指派了待办「${entity.title}」`
        );
      }
      return { todo: toTodo(entity) };
    });
  }

  /** 列出待办：状态/负责人过滤 + 分页 */
  listTodos(authorId: string, workId: string, query: ListTodosQuery): Promise<ListTodosResponse> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedWork(manager, workId, authorId);
      const page = query.page ?? 1;
      const pageSize = query.page_size ?? 20;
      const qb = manager.getRepository(TodoEntity).createQueryBuilder('todo')
        .where('todo.work_id = :workId', { workId });
      if (query.status) qb.andWhere('todo.status = :status', { status: query.status });
      if (query.assignee_id) qb.andWhere('todo.assignee_id = :assigneeId', { assigneeId: query.assignee_id });
      const [todos, total] = await qb
        .orderBy('todo.created_at', 'DESC')
        .skip((page - 1) * pageSize)
        .take(pageSize)
        .getManyAndCount();
      return { todos: todos.map(toTodo), total, page, page_size: pageSize };
    });
  }
}
