import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { WorkUploadService } from './work-upload.service';

let fixture: WritingFixture;
let service: WorkUploadService;
let rootDir: string;

beforeEach(async () => {
  fixture = await createWritingFixture();
  rootDir = join(tmpdir(), `sfa-work-upload-${randomUUID()}`);
  mkdirSync(rootDir, { recursive: true });
  service = new WorkUploadService(fixture.dataSource, rootDir);
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
  destroyWritingFixture(fixture);
});

describe('WorkUploadService', () => {
  it('persists uploaded files under uploads/works/<workId>/ and returns their metadata', async () => {
    const result = await service.uploadFiles(fixture.authorId, fixture.workId, [
      { originalname: '大纲.md', buffer: Buffer.from('# 大纲', 'utf8') },
      { originalname: '..\\..\\设定.txt', buffer: Buffer.from('设定', 'utf8') }
    ]);

    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toMatchObject({ name: '大纲.md', size: Buffer.byteLength('# 大纲') });
    // 路径穿越被清洗为单层文件名
    expect(result.files[1]?.name).toBe('设定.txt');

    const dir = join(rootDir, 'works', fixture.workId);
    expect(readdirSync(dir)).toHaveLength(2);
    expect(readFileSync(join(dir, '大纲.md'), 'utf8')).toBe('# 大纲');
  });

  it('appends a counter to duplicate file names in the same work', async () => {
    await service.uploadFiles(fixture.authorId, fixture.workId, [
      { originalname: '设定.txt', buffer: Buffer.from('v1', 'utf8') }
    ]);
    const second = await service.uploadFiles(fixture.authorId, fixture.workId, [
      { originalname: '设定.txt', buffer: Buffer.from('v2', 'utf8') }
    ]);
    expect(second.files[0]?.name).toBe('设定-1.txt');
    expect(existsSync(join(rootDir, 'works', fixture.workId, '设定.txt'))).toBe(true);
    expect(existsSync(join(rootDir, 'works', fixture.workId, '设定-1.txt'))).toBe(true);
  });

  it('rejects an empty file list with 400', async () => {
    await expect(service.uploadFiles(fixture.authorId, fixture.workId, []))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects uploading to a work owned by another author with 404', async () => {
    await expect(service.uploadFiles(fixture.otherAuthorId, fixture.workId, [
      { originalname: 'x.md', buffer: Buffer.from('x') }
    ])).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects unsupported extension with 400 and oversized file with 413', async () => {
    await expect(service.uploadFiles(fixture.authorId, fixture.workId, [
      { originalname: '恶意.exe', buffer: Buffer.from('x') }
    ])).rejects.toBeInstanceOf(BadRequestException);

    await expect(service.uploadFiles(fixture.authorId, fixture.workId, [
      { originalname: '大文件.md', buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 0) }
    ])).rejects.toBeInstanceOf(PayloadTooLargeException);
  });
});
