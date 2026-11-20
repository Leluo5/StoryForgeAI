import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DataSource } from 'typeorm';
import type { GrowthEventOrigin } from '../database/character-enums';
import { ChapterEntity } from '../database/chapter.entity';
import { CharacterEntity } from '../database/character.entity';
import { CharacterGrowthEventEntity } from '../database/character-growth-event.entity';
import { PlotNodeEntity } from '../database/plot-node.entity';
import { PlotTreeEntity } from '../database/plot-tree.entity';
import { WorkEntity } from '../database/work.entity';
import { AuditService } from '../revision/audit.service';

export interface GrowthEventInput {
  title: string;
  content?: string;
  event_time?: string | null;
  plot_node_id?: string | null;
  chapter_id?: string | null;
  origin?: GrowthEventOrigin;
}

export interface GrowthEventWarning {
  code: 'PLOT_NODE_MISSING';
  message: string;
  plot_node_id: string;
}

// F2 §2.2.7、§4.4、§2.5 成长事件服务
// - plot_node_id 弱引用（不建外键），节点标题快照保证删除后仍可解释
// - chapter_id 必须同作品（真外键）
// - 归档角色的成长事件只读（Q5）：状态 archived 禁止写
@Injectable()
export class CharacterGrowthService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  private async assertOwnedWork(manager: EntityManager, authorId: string, workId: string): Promise<void> {
    const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('作品不存在');
  }

  private async assertCharacterWriteable(manager: EntityManager, characterId: string, workId: string): Promise<void> {
    const char = await manager.getRepository(CharacterEntity).findOneBy({ id: characterId, work_id: workId });
    if (!char) throw new NotFoundException('角色不存在');
    if (char.status !== 'active') {
      throw new ConflictException({
        code: 'CHARACTER_GROWTH_READONLY',
        message: '角色已归档/合并，成长事件只读'
      });
    }
  }

  async list(authorId: string, workId: string, characterId: string): Promise<CharacterGrowthEventEntity[]> {
    await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      await manager.getRepository(CharacterEntity).findOneByOrFail({ id: characterId, work_id: workId });
    });
    return this.dataSource
      .getRepository(CharacterGrowthEventEntity)
      .find({ where: { character_id: characterId }, order: { created_at: 'DESC' } });
  }

  async create(
    authorId: string,
    workId: string,
    characterId: string,
    input: GrowthEventInput
  ): Promise<{ event: CharacterGrowthEventEntity; warning?: GrowthEventWarning | null }> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      await this.assertCharacterWriteable(manager, characterId, workId);

      if (!input.title.trim()) throw new BadRequestException('title 不能为空');

      let plotNodeTitle: string | null = null;
      let warning: GrowthEventWarning | undefined;
      if (input.plot_node_id) {
        const node = await manager
          .getRepository(PlotNodeEntity)
          .createQueryBuilder('n')
          .innerJoin(PlotTreeEntity, 't', 't.id = n.tree_id AND t.work_id = :workId', { workId })
          .where('n.id = :nodeId', { nodeId: input.plot_node_id })
          .getOne();
        if (!node) {
          warning = {
            code: 'PLOT_NODE_MISSING',
            message: '剧情节点不存在，已记录但不保存标题快照',
            plot_node_id: input.plot_node_id
          };
        } else {
          plotNodeTitle = node.title;
        }
      }

      if (input.chapter_id) {
        const chapter = await manager.getRepository(ChapterEntity).findOneBy({
          id: input.chapter_id,
          work_id: workId
        });
        if (!chapter) throw new NotFoundException('章节不存在或跨作品');
      }

      const repo = manager.getRepository(CharacterGrowthEventEntity);
      const saved = await repo.save(
        repo.create({
          id: randomUUID(),
          work_id: workId,
          character_id: characterId,
          title: input.title.trim(),
          content: input.content ?? '',
          event_time: input.event_time ?? null,
          plot_node_id: input.plot_node_id ?? null,
          plot_node_title: plotNodeTitle,
          chapter_id: input.chapter_id ?? null,
          status: 'active',
          archived_at: null,
          origin: input.origin ?? 'manual'
        })
      );
      await this.audit.record(
        authorId,
        'growth_create',
        'character_growth',
        saved.id,
        { character_id: characterId, title: saved.title },
        workId,
        manager
      );
      return warning ? { event: saved, warning } : { event: saved };
    });
  }

  async update(
    authorId: string,
    workId: string,
    eventId: string,
    input: Partial<GrowthEventInput>
  ): Promise<CharacterGrowthEventEntity> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const repo = manager.getRepository(CharacterGrowthEventEntity);
      const ev = await repo.findOneBy({ id: eventId, work_id: workId });
      if (!ev) throw new NotFoundException('成长事件不存在');
      const char = await manager.getRepository(CharacterEntity).findOneBy({ id: ev.character_id, work_id: workId });
      if (!char) throw new NotFoundException('角色不存在');
      if (char.status !== 'active') {
        throw new ConflictException({ code: 'CHARACTER_GROWTH_READONLY', message: '角色已归档/合并，成长事件只读' });
      }

      if (input.title !== undefined) ev.title = input.title.trim();
      if (input.content !== undefined) ev.content = input.content;
      if (input.event_time !== undefined) ev.event_time = input.event_time ?? null;
      if (input.plot_node_id !== undefined) {
        ev.plot_node_id = input.plot_node_id ?? null;
        ev.plot_node_title = null;
        if (input.plot_node_id) {
          const node = await manager
            .getRepository(PlotNodeEntity)
            .createQueryBuilder('n')
            .innerJoin(PlotTreeEntity, 't', 't.id = n.tree_id AND t.work_id = :workId', { workId })
            .where('n.id = :nodeId', { nodeId: input.plot_node_id })
            .getOne();
          if (node) ev.plot_node_title = node.title;
        }
      }
      if (input.chapter_id !== undefined) {
        if (input.chapter_id) {
          const chapter = await manager.getRepository(ChapterEntity).findOneBy({
            id: input.chapter_id,
            work_id: workId
          });
          if (!chapter) throw new NotFoundException('章节不存在或跨作品');
        }
        ev.chapter_id = input.chapter_id ?? null;
      }
      const saved = await repo.save(ev);
      await this.audit.record(
        authorId,
        'growth_update',
        'character_growth',
        saved.id,
        { title: saved.title },
        workId,
        manager
      );
      return saved;
    });
  }

  async delete(authorId: string, workId: string, eventId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const repo = manager.getRepository(CharacterGrowthEventEntity);
      const ev = await repo.findOneBy({ id: eventId, work_id: workId });
      if (!ev) throw new NotFoundException('成长事件不存在');
      const char = await manager.getRepository(CharacterEntity).findOneBy({ id: ev.character_id, work_id: workId });
      if (!char) throw new NotFoundException('角色不存在');
      if (char.status !== 'active') {
        throw new ConflictException({ code: 'CHARACTER_GROWTH_READONLY', message: '角色已归档/合并，成长事件只读' });
      }
      await repo.delete({ id: eventId });
      await this.audit.record(
        authorId,
        'growth_delete',
        'character_growth',
        eventId,
        { title: ev.title },
        workId,
        manager
      );
    });
  }
}
