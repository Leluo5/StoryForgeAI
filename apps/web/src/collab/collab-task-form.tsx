import { useCallback, useState, type JSX } from 'react';
import type { CollabRoleField } from '@storyforge/contracts';
import type { CollabClient, CreateRoleProfileTaskResult } from './collab-client';
import './collab-panel.css';

const FIELD_OPTIONS: { value: CollabRoleField; label: string }[] = [
  { value: 'identity', label: '身份定位' },
  { value: 'personality', label: '性格' },
  { value: 'experience', label: '经历' }
];

interface Props {
  workId: string;
  client: CollabClient;
  /** 当前测试角色 ID（由面板从角色详情传入） */
  characterId: string;
  /** 白名单字段（来自协同设置） */
  whitelistFields: CollabRoleField[];
  onCreated?: (result: CreateRoleProfileTaskResult) => void;
}

export function CollabTaskForm({ workId, client, characterId, whitelistFields, onCreated }: Props): JSX.Element {
  const [fields, setFields] = useState<CollabRoleField[]>(whitelistFields.slice(0, 1));
  const [instruction, setInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const toggleField = useCallback((field: CollabRoleField) => {
    setFields((prev) => (prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]));
  }, []);

  const submit = useCallback(async () => {
    if (fields.length === 0) { setError('至少选择一个生成字段'); return; }
    if (!instruction.trim()) { setError('请输入生成指令'); return; }
    setSubmitting(true);
    setError('');
    try {
      const result = await client.createRoleProfileTask(workId, {
        character_id: characterId,
        fields,
        instruction: instruction.trim()
      });
      setInstruction('');
      onCreated?.(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '任务创建失败');
    } finally {
      setSubmitting(false);
    }
  }, [client, workId, characterId, fields, instruction, onCreated]);

  return (
    <div className="collab-card">
      <div className="collab-card-title">发起角色资料生成</div>
      <div className="collab-label">
        生成字段
        <div className="collab-fields">
          {FIELD_OPTIONS.map((option) => (
            <label key={option.value} className="collab-check">
              <input
                type="checkbox"
                checked={fields.includes(option.value)}
                disabled={!whitelistFields.includes(option.value)}
                onChange={() => toggleField(option.value)}
              />
              {option.label}
              {!whitelistFields.includes(option.value) && <span className="collab-tag collab-tag-muted">未白名单</span>}
            </label>
          ))}
        </div>
      </div>
      <label className="collab-label">
        生成指令
        <textarea
          className="collab-textarea"
          value={instruction}
          maxLength={500}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="例：为这位角色补充一段冒险经历，注意与已有身份定位一致"
        />
      </label>
      <div className="collab-actions">
        <button
          type="button"
          className="collab-btn"
          disabled={submitting || fields.length === 0 || !instruction.trim()}
          onClick={() => void submit()}
        >
          {submitting ? '提交中…' : '发起生成'}
        </button>
      </div>
      {error && <div className="collab-error">{error}</div>}
    </div>
  );
}
