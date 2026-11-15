import { spawnSync } from 'node:child_process';

export default function globalSetup(): void {
  const result = spawnSync('pnpm', ['--filter', '@storyforge/api', 'test:prepare'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    // Node 22 禁止直接 spawn Windows 的 .cmd 文件；本机 pnpm 是 pnpm.exe，交给 shell 解析。
    shell: process.platform === 'win32'
  });
  if (result.status !== 0) throw new Error('E2E database preparation failed');
}
