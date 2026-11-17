import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { env } from './config/env';
import { AiTaskProcessor } from './ai/ai-task.processor';

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);

  // 启动 AI 任务消费 Worker（A5/A8 要求：bootstrap 时拉起队列消费者，任务才能 queued→running→succeeded）
  const worker = app.get(AiTaskProcessor).createWorker();

  await app.listen(env.PORT, '127.0.0.1');

  // 优雅关闭：先停 Worker（不再消费），再关 HTTP，最后收尾
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[bootstrap] ${signal}: closing AI worker`);
    await worker.close();
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

if (require.main === module) {
  void bootstrap().catch(() => {
    console.error('API failed to start');
    process.exitCode = 1;
  });
}
