import type { JSX } from 'react';
import { KnowledgeManager } from './knowledge-manager';
import './knowledge-page.css';

/**
 * 知识库独立页（/knowledge）—— 方案 C：全局知识库管理中心（三栏布局）。
 * 左导航(类型/标签/收藏) + 中间列表(筛选+卡片) + 右侧详情(类型模板+四维大纲)。
 * 日常快速检索/引用走工作台抽屉（方案 D），本页面向深度整理与批量操作。
 */
export function KnowledgePage(): JSX.Element {
  return <KnowledgeManager />;
}
