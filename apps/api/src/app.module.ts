import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { AppDataSource } from './database/data-source';
import { HealthController } from './health.controller';

@Module({
  imports: [TypeOrmModule.forRoot({ ...AppDataSource.options })],
  controllers: [HealthController]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
