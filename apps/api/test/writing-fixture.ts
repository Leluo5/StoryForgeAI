import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../src/database/data-source';
import { AuthorEntity } from '../src/database/author.entity';
import { ChapterEntity } from '../src/database/chapter.entity';
import { WorkService } from '../src/writing/work.service';
import { testDatabaseUrl } from './test-database';

export interface WritingFixture {
  dataSource: DataSource;
  authorId: string;
  otherAuthorId: string;
  workId: string;
  volumeId: string;
  chapterId: string;
  clientId: string;
}

export async function createWritingFixture(): Promise<WritingFixture> {
  const testDataSource = createDataSource(testDatabaseUrl());
  await testDataSource.initialize();
  await testDataSource.runMigrations();
  const authors = testDataSource.getRepository(AuthorEntity);
  const author = await authors.save(authors.create({
    id: randomUUID(),
    email: `m1-${randomUUID()}@example.com`,
    display_name: 'M1 Author',
    password_hash: 'not-used-by-writing-tests'
  }));
  const other = await authors.save(authors.create({
    id: randomUUID(),
    email: `m1-${randomUUID()}@example.com`,
    display_name: 'Other Author',
    password_hash: 'not-used-by-writing-tests'
  }));
  const created = await new WorkService(testDataSource).create(author.id, {
    title: '夹具作品', description: '真实数据库测试'
  });
  const dataSource = testDataSource;
  const workId = created.work.id;
  const chapterId = created.first_chapter_id;
  const chapter = await dataSource.getRepository(ChapterEntity).findOneByOrFail({ id: chapterId });
  return {
    dataSource,
    authorId: author.id,
    otherAuthorId: other.id,
    workId,
    volumeId: chapter.volume_id,
    chapterId,
    clientId: randomUUID()
  };
}

export async function destroyWritingFixture(fixture: WritingFixture): Promise<void> {
  await fixture.dataSource.getRepository(AuthorEntity).delete({
    id: fixture.authorId
  });
  await fixture.dataSource.getRepository(AuthorEntity).delete({
    id: fixture.otherAuthorId
  });
  if (fixture.dataSource.isInitialized) await fixture.dataSource.destroy();
}
