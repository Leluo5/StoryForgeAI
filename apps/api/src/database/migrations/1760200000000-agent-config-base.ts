import type { MigrationInterface, QueryRunner } from 'typeorm';

// M3b Agent 配置与管理：Agent 配置实体 + 工具注册表 + 工具↔Agent 绑定
// ai_agents：作者级 Agent 配置（模型 + 参数 + 默认互斥）
// ai_tools：服务端权威工具注册表（工具可绑定 Agent、可启停）
// 种子数据（迁移层只预置全局权威的 4 工具）：
//   - ai_tools 表无作者依赖，可全局预置（M3a 硬编码 4 工具由本表替代）
//   - ai_agents 为作者级（author_id 非空外键），空库无作者可挂，故默认 Mock Agent
//     不由迁移预置，改由服务层按需懒创建（agent.service.ts ensureDefaultAgent），
//     作者首次访问/发起任务时自动建默认 Mock Agent 并绑定全部工具，保证缺配置不中断。
export class AgentConfigBase1760200000000 implements MigrationInterface {
  name = 'AgentConfigBase1760200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Agent：作者级配置，同作者名称唯一 + 同刻仅一个默认（唯一部分索引）
    await queryRunner.query(`
      CREATE TABLE ai_agents (
        id uuid PRIMARY KEY,
        author_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        name varchar(80) NOT NULL,
        platform varchar(24) NOT NULL DEFAULT 'mock',
        model_id varchar(80) NOT NULL,
        model_config jsonb NOT NULL DEFAULT '{}',
        status varchar(16) NOT NULL DEFAULT 'active'
          CHECK (status IN ('active','disabled')),
        is_default boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_ai_agents_author_name UNIQUE (author_id, name)
      )
    `);
    // 同作者同刻仅一个默认 Agent（防并发竞争）
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_ai_agents_author_default ON ai_agents(author_id) WHERE is_default'
    );
    await queryRunner.query('CREATE INDEX idx_ai_agents_author ON ai_agents(author_id, created_at DESC)');
    await queryRunner.query('CREATE INDEX idx_ai_agents_status ON ai_agents(author_id, status)');

    // 工具注册表：服务端权威，工具可绑定 Agent、可启停
    await queryRunner.query(`
      CREATE TABLE ai_tools (
        id uuid PRIMARY KEY,
        tool_id varchar(40) NOT NULL,
        name varchar(80) NOT NULL,
        description varchar(255),
        agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL,
        enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_ai_tools_tool_id UNIQUE (tool_id)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_ai_tools_enabled ON ai_tools(enabled)');

    // 预置 4 个工具（M3a 支持的 continue/polish/expand/rewrite），全局权威、幂等
    await queryRunner.query(`
      INSERT INTO ai_tools (id, tool_id, name, description, enabled)
      VALUES
        (gen_random_uuid(), 'continue', '续写', '延续当前章节内容', true),
        (gen_random_uuid(), 'polish', '润色', '优化语句与表达', true),
        (gen_random_uuid(), 'expand', '扩写', '丰富细节与描写', true),
        (gen_random_uuid(), 'rewrite', '改写', '重写指定段落', true)
      ON CONFLICT (tool_id) DO NOTHING
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS ai_tools');
    await queryRunner.query('DROP TABLE IF EXISTS ai_agents');
  }
}
