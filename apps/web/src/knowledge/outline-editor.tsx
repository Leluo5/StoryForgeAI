// ============================================================================
// M3c-3 知识库 · 大纲编辑器（T33）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §6.5
//
// 职责：编辑大纲「章节」维度（标题 + 摘要），可增删章节、改要点。
//       保存时组装完整 KnowledgeEntryOutline 并携带 expected_version 乐观锁，
//       交由 OutlinePanel.onSave → patchEntry。
// ============================================================================

import { useState } from 'react';
import { Button, Input, Textarea } from '@storyforge/ui';
import type { KnowledgeEntryOutline } from '@storyforge/contracts';

const TITLE_MAX = 200;
const SUMMARY_MAX = 20_000;

interface Props {
  outline: KnowledgeEntryOutline;
  /** 当前条目版本，作为 expected_version 乐观锁 */
  version: number;
  onSave?: (outline: KnowledgeEntryOutline, expectedVersion: number) => void | Promise<void>;
  saving?: boolean;
}

/** 大纲编辑器（M3c-3 T33）。 */
export function OutlineEditor({ outline, version, onSave, saving = false }: Props) {
  const [chapters, setChapters] = useState(() => outline.chapters.map((c) => ({ ...c })));

  const updateChapter = (index: number, patch: { title?: string; summary?: string }) => {
    setChapters((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  const addChapter = () => {
    setChapters((prev) => [...prev, { title: '', summary: '' }]);
  };

  const removeChapter = (index: number) => {
    setChapters((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = () => {
    if (!onSave) return;
    const next: KnowledgeEntryOutline = {
      chapters: chapters.map((c) => ({ title: c.title.trim(), summary: c.summary })),
      plot_nodes: outline.plot_nodes,
      character_relations: outline.character_relations,
      story_lines: outline.story_lines
    };
    void onSave(next, version);
  };

  return (
    <div className="outline-editor">
      <div className="outline-editor__header">
        <h4>章节</h4>
        <Button variant="secondary" size="sm" onClick={addChapter} disabled={saving}>
          添加章节
        </Button>
      </div>
      {chapters.length === 0 ? (
        <p className="outline-editor__empty">暂无章节，点击「添加章节」。</p>
      ) : (
        <ul className="outline-editor__chapters">
          {chapters.map((chapter, index) => (
            <li key={index} className="outline-editor__chapter">
              <div className="outline-editor__chapter-row">
                <Input
                  label={`章节 ${index + 1} 标题`}
                  placeholder="章节标题"
                  value={chapter.title}
                  maxLength={TITLE_MAX}
                  onChange={(e) => updateChapter(index, { title: e.target.value })}
                />
                <Button variant="ghost" size="sm" onClick={() => removeChapter(index)} disabled={saving} aria-label={`删除章节 ${index + 1}`}>
                  删除章节
                </Button>
              </div>
              <Textarea
                label={`章节 ${index + 1} 摘要`}
                placeholder="章节摘要 / 要点"
                value={chapter.summary}
                maxLength={SUMMARY_MAX}
                rows={3}
                onChange={(e) => updateChapter(index, { summary: e.target.value })}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="outline-editor__actions">
        <Button variant="primary" size="sm" onClick={handleSave} disabled={saving || chapters.length === 0}>
          {saving ? '保存中…' : '保存大纲'}
        </Button>
      </div>
    </div>
  );
}
