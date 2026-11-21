import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { CollabSettings, CollabRoleField, PutCollabSettingsRequest } from '@storyforge/contracts';
import type { CollabClient } from './collab-client';
import { collabErrorMessage } from './collab-state';
import './collab.css';

const FIELD_OPTIONS: { value: CollabRoleField; label: string; hint: string }[] = [
  { value: 'identity', label: '身份定位', hint: '身份' },
  { value: 'personality', label: '性格', hint: '性格' },
  { value: 'experience', label: '经历', hint: '经历' }
];

interface Props {
  workId: string;
  client: CollabClient;
  /** 当前角色是否为该作品的唯一测试角色（决定是否可编辑） */
  isTestCharacter: boolean;
  onSaved?: (settings: CollabSettings) => void;
}

export function CollabSettingsForm({ workId, client, isTestCharacter, onSaved }: Props): JSX.Element {
  const [settings, setSettings] = useState<CollabSettings | null>(null);
  const [characters, setCharacters] = useState<{ id: string; name: string }[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string; platform: string }[]>([]);
  const [testCharacterId, setTestCharacterId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [fields, setFields] = useState<CollabRoleField[]>(['identity', 'personality']);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [existing, chars, ags] = await Promise.all([
        client.getSettings(workId),
        client.listCharacters(workId),
        client.listCollabAgents()
      ]);
      setCharacters(chars.items);
      setAgents(ags.map((agent) => ({ id: agent.id, name: agent.name, platform: agent.platform })));
      setSettings(existing);
      setTestCharacterId(existing?.test_character_id ?? '');
      setAgentId(existing?.agent_id ?? '');
      setFields(existing?.whitelist_fields ?? ['identity', 'personality']);
      setEnabled(existing?.enabled ?? false);
      setError('');
    } catch (cause) {
      setError(collabErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [client, workId]);

  useEffect(() => { void load(); }, [load]);

  const canEdit = isTestCharacter && !loading;

  const toggleField = useCallback((field: CollabRoleField) => {
    setFields((prev) => (prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]));
  }, []);

  const submit = useCallback(async () => {
    if (fields.length < 2) { setError('白名单至少选择 2 个字段'); return; }
    setSaving(true);
    setError('');
    try {
      const body: PutCollabSettingsRequest = {
        test_character_id: testCharacterId,
        agent_id: agentId,
        whitelist_fields: fields,
        enabled
      };
      const saved = await client.putSettings(workId, body);
      setSettings(saved);
      onSaved?.(saved);
    } catch (cause) {
      setError(collabErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }, [client, workId, testCharacterId, agentId, fields, enabled, onSaved]);

  const isConfigured = useMemo(
    () => Boolean(testCharacterId && agentId && fields.length >= 2),
    [testCharacterId, agentId, fields]
  );

  if (loading) return <div className="collab-card collab-muted">加载协同设置…</div>;

  return (
    <div className="collab-card">
      <div className="collab-card-title">协同设置</div>
      {!isTestCharacter && (
        <div className="collab-note">
          仅作品的唯一测试角色可编辑协同配置，其余角色只读。
        </div>
      )}
      <label className="collab-label">
        测试角色
        <select
          value={testCharacterId}
          disabled={!canEdit}
          onChange={(e) => setTestCharacterId(e.target.value)}
          className="collab-select"
        >
          <option value="">选择角色</option>
          {characters.map((character) => (
            <option key={character.id} value={character.id}>{character.name}</option>
          ))}
        </select>
      </label>
      <label className="collab-label">
        执行 Agent
        <select
          value={agentId}
          disabled={!canEdit}
          onChange={(e) => setAgentId(e.target.value)}
          className="collab-select"
        >
          <option value="">选择 Agent</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}（{agent.platform}）
            </option>
          ))}
        </select>
      </label>
      <div className="collab-label">
        允许自动写回字段（至少 2 项）
        <div className="collab-fields">
          {FIELD_OPTIONS.map((option) => (
            <label key={option.value} className="collab-check">
              <input
                type="checkbox"
                checked={fields.includes(option.value)}
                disabled={!canEdit}
                onChange={() => toggleField(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </div>
      <label className="collab-check">
        <input type="checkbox" checked={enabled} disabled={!canEdit} onChange={(e) => setEnabled(e.target.checked)} />
        启用协同
      </label>
      <div className="collab-actions">
        <button
          type="button"
          className="collab-btn"
          disabled={!canEdit || saving || !isConfigured}
          onClick={() => void submit()}
        >
          {saving ? '保存中…' : '保存设置'}
        </button>
        {settings?.enabled && <span className="collab-tag">已启用</span>}
      </div>
      {error && <div className="collab-error">{error}</div>}
    </div>
  );
}
