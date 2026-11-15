import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { env } from '../config/env';
import { AuthorEntity } from './author.entity';
import { SessionEntity } from './session.entity';
import { AuthBase1736899200000 } from './migrations/1736899200000-auth-base';

export function createDataSource(databaseUrl: string = env.DATABASE_URL): DataSource {
  return new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: [AuthorEntity, SessionEntity],
    migrations: [AuthBase1736899200000],
    migrationsTableName: 'migrations',
    synchronize: false,
    migrationsRun: false,
    logging: false
  });
}

export const AppDataSource = createDataSource();
