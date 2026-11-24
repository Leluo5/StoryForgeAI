import type { MigrationInterface, QueryRunner } from 'typeorm';

// 作者级站点设置：每个作者一条（author_id 唯一），配置站点信息/LLM 配置/平台凭据。
// F4：作者登录即可访问自己的后台，无独立认证；站点设置字段含 llm_config 与 platform_credentials（jsonb）。
export class SiteConfig1761000000000 implements MigrationInterface {
  name = 'SiteConfig1761000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE site_config (
        id uuid PRIMARY KEY,
        author_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        site_name varchar(120) NOT NULL DEFAULT '我的创作站',
        site_description text NOT NULL DEFAULT '',
        theme varchar(16) NOT NULL DEFAULT 'light',
        llm_config jsonb NOT NULL DEFAULT '{}',
        platform_credentials jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_site_config_author UNIQUE (author_id)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS site_config');
  }
}
