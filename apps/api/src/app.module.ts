import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { AppDataSource } from './database/data-source';
import { HealthController } from './health.controller';
import { WritingModule } from './writing/writing.module';
import { RevisionModule } from './revision/revision.module';
import { AiTaskModule } from './ai/ai-task.module';

@Module({
  imports: [TypeOrmModule.forRoot({ ...AppDataSource.options }), AuthModule, WritingModule, RevisionModule, AiTaskModule],
  controllers: [HealthController]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
