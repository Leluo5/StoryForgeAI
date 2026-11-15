import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { env } from './config/env';

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(env.PORT, '127.0.0.1');
}

if (require.main === module) {
  void bootstrap().catch(() => {
    console.error('API failed to start');
    process.exitCode = 1;
  });
}
