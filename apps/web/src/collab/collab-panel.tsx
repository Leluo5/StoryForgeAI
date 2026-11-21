import { useCallback, useEffect, useState, type JSX } from 'react';
import type { CollabReadiness, CollabSettings, CollabRoleField } from '@storyforge/contracts';
import type { TaskEvent } from '../ai/ai-client';
import { collabClient, type CollabClient, type CreateRoleProfileTaskResult } from './collab-client';
import { CollabSettingsForm } from './collab-settings-form';
import { CollabTaskForm } from './collab-task-form';
import { CollabTaskProgress } from './collab-task-progress';
import { CollabWritebackList } from './collab-writeback-list';
import './collab-panel.css';

interface Props {
  workId: string;
  /** 当前角色 ID（角色详情页签传入） */
  characterId: string;
  client?: CollabClient;
  /** 外部订阅（复用既有任务 SSE 事件流） */
  subscribe?: (workId: string, taskId: string, onEvent: (event: TaskEvent) => void) => { close: () => void };
}

/**
 * F11 多平台 Agent 协同 · 角色详情「AI 协同」页签入口。
 * 自行加载协同设置与就绪状态；仅当当前角色为作品的唯一测试角色时渲染完整面板。
 */
export function CollabPanel({ workId, characterId, client = collabClient, subscribe }: Props): JSX.Element {
  const [settings, setSettings] = useState<CollabSettings | null>(null);
  const [readiness, setReadiness] = useState<CollabReadiness | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');

  const testCharacterId = settings?.test_character_id ?? null;
  const isTestCharacter = Boolean(testCharacterId) && characterId === testCharacterId;
  const enabled = settings?.enabled ?? false;

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([client.getSettings(workId), client.getReadiness(workId)]);
      setSettings(s);
      setReadiness(r);
      setLoadError('');
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : '协同状态加载失败');
    } finally {
      setLoaded(true);
    }
  }, [client, workId]);

  useEffect(() => { void load(); }, [load]);

  if (!loaded) {
    return (
      <div className="collab-card">
        <div className="collab-card-title">AI 协同</div>
        <div className="collab-muted">加载协同状态…</div>
      </div>
    );
  }

  if (!testCharacterId) {
    return (
      <div className="collab-card">
        <div className="collab-card-title">AI 协同</div>
        <div className="collab-note">
          尚未配置协同设置，请先在任一角色页配置测试角色与执行 Agent。
        </div>
      </div>
    );
  }

  if (!isTestCharacter) {
    return (
      <div className="collab-card">
        <div className="collab-card-title">AI 协同</div>
        <div className="collab-note">当前角色非作品测试角色，仅支持查看协同状态。</div>
      </div>
    );
  }

  const whitelistFields: CollabRoleField[] = settings?.whitelist_fields ?? [];
  const channelReady = readiness?.channels.flowise.configured || readiness?.channels.coze.configured;

  const onCreated = (result: CreateRoleProfileTaskResult): void => {
    setCurrentTaskId(result.task.id);
  };

  return (
    <div className="collab-panel">
      {loadError && <div className="collab-error">{loadError}</div>}
      <CollabSettingsForm
        workId={workId}
        client={client}
        isTestCharacter={isTestCharacter}
        onSaved={(saved) => { setSettings(saved); void load(); }}
      />
      {enabled && (
        <>
          {channelReady ? (
            <CollabTaskForm
              workId={workId}
              client={client}
              characterId={characterId}
              whitelistFields={whitelistFields}
              onCreated={onCreated}
            />
          ) : (
            <div className="collab-card">
              <div className="collab-card-title">执行通道未就绪</div>
              <div className="collab-note">
                请先在 Agent 配置中为执行 Agent 设置平台参数。
              </div>
            </div>
          )}
          {currentTaskId && (
            <CollabTaskProgress
              key={currentTaskId}
              workId={workId}
              taskId={currentTaskId}
              client={client}
              {...(subscribe ? { subscribe } : {})}
            />
          )}
          <CollabWritebackList workId={workId} characterId={characterId} client={client} />
        </>
      )}
    </div>
  );
}
