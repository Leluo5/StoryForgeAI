import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { ChapterEntity } from '../database/chapter.entity';
import { CharacterEntity } from '../database/character.entity';
import { CharacterTextAnchorEntity } from '../database/character-text-anchor.entity';
import { CharacterArchiveScanEntity } from '../database/character-archive-scan.entity';
import { CharacterAnchorService } from './character-anchor.service';

let fixture: WritingFixture;
let auditMock: { record: ReturnType<typeof vi.fn> };
let service: CharacterAnchorService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  auditMock = { record: vi.fn() };
  service = new CharacterAnchorService(fixture.dataSource, auditMock as never);
});

afterEach(() => destroyWritingFixture(fixture));

function makeHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 64);
}

function makeDocWithParagraphs(paragraphs: string[]) {
  return {
    type: 'doc',
    content: paragraphs.map((text, idx) => ({
      type: 'paragraph',
      attrs: { pid: `pid-${idx}` },
      content: [{ type: 'text', text }]
    }))
  };
}

async function createChar(name: string, status: 'active' | 'archived' = 'active'): Promise<string> {
  const repo = fixture.dataSource.getRepository(CharacterEntity);
  const now = new Date();
  const e = repo.create({
    id: randomUUID(), work_id: fixture.workId, name, name_key: name.toLowerCase(),
    identity: null, age: 20, gender: '男', personality: '', experience: '',
    country_region: null, faith: null, faction: null, race: null, occupation: null,
    age_band: 'young', attributes: [], avatar_asset_id: null,
    status, merged_into_id: null,
    archived_at: status === 'archived' ? now : null,
    archived_by: status === 'archived' ? fixture.authorId : null,
    origin: 'manual', version: 1
  });
  return (await repo.save(e)).id;
}

async function createChapter(title: string, paragraphs: string[]): Promise<string> {
  const repo = fixture.dataSource.getRepository(ChapterEntity);
  const doc = makeDocWithParagraphs(paragraphs);
  const content = paragraphs.join('');
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 64);
  const e = repo.create({
    id: randomUUID(), work_id: fixture.workId, volume_id: fixture.volumeId,
    position: 50, title,
    document: doc as unknown as Record<string, unknown>,
    content_hash: hash, version: 1
  });
  return (await repo.save(e)).id;
}

async function createAnchor(
  characterId: string,
  chapterId: string,
  paragraphPid: string,
  text: string
): Promise<string> {
  // scan_id 有 FK 约束，需要先建 scan
  const scanRepo = fixture.dataSource.getRepository(CharacterArchiveScanEntity);
  const scan = await scanRepo.save(
    scanRepo.create({
      id: randomUUID(), work_id: fixture.workId, character_id: characterId,
      requested_by: fixture.authorId, status: 'succeeded',
      total_chapters: 1, scanned_chapters: 1, matched_paragraphs: 1,
      error: null, started_at: new Date(), finished_at: new Date()
    })
  );

  const repo = fixture.dataSource.getRepository(CharacterTextAnchorEntity);
  const a = repo.create({
    id: randomUUID(), work_id: fixture.workId,
    character_id: characterId,
    chapter_id: chapterId,
    scan_id: scan.id,
    paragraph_pid: paragraphPid,
    matched_name: '',
    excerpt: text.slice(0, 120),
    excerpt_hash: makeHash(text),
    status: 'active',
    invalid_reason: null,
    dismissed_at: null,
    dismissed_by: null
  });
  return (await repo.save(a)).id;
}

describe('T19 CharacterAnchorService', () => {
  // ──────────────────── 1. 正常读取 ────────────────────

  it('正常读取：返回 paragraph_marks，不含 excerpt_hash', async () => {
    const charId = await createChar('江离', 'archived');
    const chapterId = await createChapter('ch1', ['江离缓缓走出林间。', '远处传来鸟鸣。']);
    const a1 = await createAnchor(charId, chapterId, 'pid-0', '江离缓缓走出林间。');
    await createAnchor(charId, chapterId, 'pid-1', '远处传来鸟鸣。');

    const res = await service.readMarks(fixture.authorId, fixture.workId, charId);
    expect(res.paragraph_marks.length).toBe(2);
    const first = res.paragraph_marks[0]!;
    expect(first.anchor_id).toBe(a1);
    expect(first).not.toHaveProperty('excerpt_hash');
    expect(res.chapter_marks).toEqual([]);
  });

  // ──────────────────── 2. text_changed 失效 ────────────────────

  it('修改段落文本 → 惰性失效 text_changed；chapter_marks 兜底提示', async () => {
    const charId = await createChar('江离', 'archived');
    const chapterId = await createChapter('ch1', ['江离缓缓走出林间。', '远处传来鸟鸣。']);
    await createAnchor(charId, chapterId, 'pid-0', '江离缓缓走出林间。');

    // 修改 chapter.document 文本
    const chapterRepo = fixture.dataSource.getRepository(ChapterEntity);
    const doc = makeDocWithParagraphs(['江离缓缓走出林间——改了！', '远处传来鸟鸣。']);
    await chapterRepo
      .createQueryBuilder()
      .update()
      .set({ document: doc as unknown as Record<string, unknown> } as Record<string, unknown>)
      .where('id = :id', { id: chapterId })
      .execute();

    const res = await service.readMarks(fixture.authorId, fixture.workId, charId);
    const mark = res.paragraph_marks.find((m) => m.paragraph_pid === 'pid-0')!;
    expect(mark.status).toBe('invalid');
    expect(mark.invalid_reason).toBe('text_changed');

    // chapter_marks 有兜底提示
    const chMark = res.chapter_marks.find((c) => c.chapter_id === chapterId)!;
    expect(chMark.has_invalid).toBe(true);
    expect(chMark.reason_code).toBe('text_changed');
    expect(chMark.message).toMatch(/原文已被修改/);
  });

  // ──────────────────── 3. pid_missing 失效 ────────────────────

  it('删除段落 → pid_missing 失效', async () => {
    const charId = await createChar('江离', 'archived');
    const chapterId = await createChapter('ch1', ['江离缓缓走出林间。', '远处传来鸟鸣。']);
    await createAnchor(charId, chapterId, 'pid-0', '江离缓缓走出林间。');

    // 删掉 pid-0：只保留 pid-1 段落（自定义 pid 避免重新编号）
    const chapterRepo = fixture.dataSource.getRepository(ChapterEntity);
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { pid: 'pid-1' },
          content: [{ type: 'text', text: '远处传来鸟鸣。' }]
        }
      ]
    };
    await chapterRepo
      .createQueryBuilder()
      .update()
      .set({ document: doc as unknown as Record<string, unknown> } as Record<string, unknown>)
      .where('id = :id', { id: chapterId })
      .execute();

    const res = await service.readMarks(fixture.authorId, fixture.workId, charId);
    const mark = res.paragraph_marks.find((m) => m.paragraph_pid === 'pid-0')!;
    expect(mark.status).toBe('invalid');
    expect(mark.invalid_reason).toBe('pid_missing');
  });

  // ──────────────────── 4. character_restored 失效 ────────────────────

  it('角色恢复 → active 锚点批量 invalid(character_restored)', async () => {
    const charId = await createChar('江离', 'archived');
    const chapterId = await createChapter('ch1', ['江离缓缓走出林间。']);
    await createAnchor(charId, chapterId, 'pid-0', '江离缓缓走出林间。');

    // 角色从 archived 恢复成 active
    const charRepo = fixture.dataSource.getRepository(CharacterEntity);
    await charRepo.update({ id: charId }, { status: 'active', archived_at: null, archived_by: null });

    const res = await service.readMarks(fixture.authorId, fixture.workId, charId);
    const mark = res.paragraph_marks[0]!;
    expect(mark.status).toBe('invalid');
    expect(mark.invalid_reason).toBe('character_restored');
  });

  // ──────────────────── 5. dismiss ────────────────────

  it('dismiss active → dismissed 幂等；invalid 剔除 409', async () => {
    const charId = await createChar('江离', 'archived');
    const chapterId = await createChapter('ch1', ['江离缓缓走出林间。']);
    const aId = await createAnchor(charId, chapterId, 'pid-0', '江离缓缓走出林间。');

    // 首次 dismiss
    const d1 = await service.dismissAnchor(fixture.authorId, fixture.workId, aId);
    expect(d1.status).toBe('dismissed');

    // 幂等：再次 dismiss 不报错
    const d2 = await service.dismissAnchor(fixture.authorId, fixture.workId, aId);
    expect(d2.status).toBe('dismissed');

    // dismissed 状态在 readMarks 时保持不动
    const res = await service.readMarks(fixture.authorId, fixture.workId, charId);
    const mark = res.paragraph_marks.find((m) => m.anchor_id === aId)!;
    expect(mark.status).toBe('dismissed');

    // 测试 invalid 剔除 409：再造一个 invalid
    await service.markAnchorsRestored(fixture.authorId, fixture.workId, charId);
    // dismiss 一个不存在的 → 404
    await expect(
      service.dismissAnchor(fixture.authorId, fixture.workId, randomUUID())
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ──────────────────── 6. markAnchorsRestored ────────────────────

  it('markAnchorsRestored 批量把 active 置 invalid(character_restored)', async () => {
    const charId = await createChar('江离', 'archived');
    const chapterId = await createChapter('ch1', ['江离缓缓走出林间。', '江离又出现了。']);
    await createAnchor(charId, chapterId, 'pid-0', '江离缓缓走出林间。');
    await createAnchor(charId, chapterId, 'pid-1', '江离又出现了。');

    const updated = await service.markAnchorsRestored(fixture.authorId, fixture.workId, charId);
    expect(updated).toBe(2);

    const list = await fixture.dataSource
      .getRepository(CharacterTextAnchorEntity)
      .find({ where: { character_id: charId } });
    for (const a of list) {
      expect(a.status).toBe('invalid');
      expect(a.invalid_reason).toBe('character_restored');
    }
  });
});
