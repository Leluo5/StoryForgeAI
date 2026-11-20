import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { CharacterEntity } from '../database/character.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { CharacterArchiveScanEntity } from '../database/character-archive-scan.entity';
import { CharacterTextAnchorEntity } from '../database/character-text-anchor.entity';
import { DataSource } from 'typeorm';
import { CharacterArchiveScanService } from './character-scan.service';
import { randomUUID } from 'node:crypto';

let fixture: WritingFixture;
let auditMock: { record: ReturnType<typeof vi.fn> };
let service: CharacterArchiveScanService;

// 构造一个含多段落的 ProseMirror 文档，其中某段落包含角色名字
function makeDoc(paragraphs: string[]): Record<string, unknown> {
  return {
    type: 'doc',
    content: paragraphs.map((text, idx) => ({
      type: 'paragraph',
      attrs: { pid: `p-${idx}` },
      content: [{ type: 'text', text }]
    }))
  };
}

async function createCharacter(name: string): Promise<string> {
  const repo = fixture.dataSource.getRepository(CharacterEntity);
  const e = repo.create({
    id: randomUUID(), work_id: fixture.workId, name, name_key: name.toLowerCase(),
    identity: null, age: 20, gender: '男', personality: '', experience: '',
    country_region: null, faith: null, faction: null, race: null, occupation: null,
    age_band: 'young', attributes: [], avatar_asset_id: null,
    status: 'active', merged_into_id: null, archived_at: null, archived_by: null,
    origin: 'manual', version: 1
  });
  return (await repo.save(e)).id;
}

async function createChapter(title: string, paragraphs: string[]): Promise<string> {
  const repo = fixture.dataSource.getRepository(ChapterEntity);
  const doc = makeDoc(paragraphs);
  const textJoined = paragraphs.join('');
  const hash = require('node:crypto').createHash('sha256').update(textJoined).digest('hex').slice(0, 64);
  const e = repo.create({
    id: randomUUID(), work_id: fixture.workId, volume_id: fixture.volumeId,
    position: 99, title,
    document: doc as unknown as Record<string, unknown>,
    content_hash: hash,
    version: 1
  });
  const saved = await repo.save(e);
  return saved.id;
}

beforeEach(async () => {
  fixture = await createWritingFixture();
  auditMock = { record: vi.fn() };
  service = new CharacterArchiveScanService(fixture.dataSource, auditMock as never);
});

afterEach(() => destroyWritingFixture(fixture));

describe('CharacterArchiveScanService', () => {
  it('start → pending；同角色重复 start → 409 SCAN_ALREADY_RUNNING', async () => {
    const charId = await createCharacter('江离');
    const scan = await service.start(fixture.authorId, fixture.workId, charId);
    expect(scan.status).toBe('pending');
    // 再 start → 409
    await expect(service.start(fixture.authorId, fixture.workId, charId))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('archived / merged 角色 → 409', async () => {
    const charId = await createCharacter('江离');
    await fixture.dataSource.getRepository(CharacterEntity).update(
      { id: charId }, { status: 'archived', archived_at: new Date(), archived_by: fixture.authorId, version: 2 }
    );
    await expect(service.start(fixture.authorId, fixture.workId, charId))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('runBatches：逐批扫描，匹配到名字就建锚点 + 进度更新', async () => {
    const charId = await createCharacter('江离');
    await createChapter('ch1', ['江离缓缓走出林间。', '远处传来鸟鸣。', '江离回望，露出微微一笑。']);
    await createChapter('ch2', ['没有任何角色名字。', '江离又出现了一次。']);

    const scan = await service.start(fixture.authorId, fixture.workId, charId);
    await service.runBatches(fixture.authorId, fixture.workId, scan.id);
    const anchors = await fixture.dataSource
      .getRepository(CharacterTextAnchorEntity)
      .find({ where: { scan_id: scan.id, character_id: charId } });
    expect(anchors.length).toBeGreaterThanOrEqual(3);
    expect(anchors.every((a) => a.status === 'active')).toBe(true);
    // 审计：character_scan_start + character_scan_progress + anchor_create 等
    const actions = auditMock.record.mock.calls.map((c) => c[1]);
    expect(actions).toContain('character_scan_start');
    expect(actions).toContain('character_scan_progress');
  });

  it('cleanupStaleRuns：遗留 pending/running 置 failed', async () => {
    const charId = await createCharacter('江离');
    const scan = await service.start(fixture.authorId, fixture.workId, charId);
    await service.cleanupStaleRuns();
    const stale = await fixture.dataSource
      .getRepository(CharacterArchiveScanEntity)
      .findOneByOrFail({ id: scan.id });
    expect(stale.status).toBe('failed');
    expect(stale.error).not.toBeNull();
  });
});
