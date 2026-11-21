import { useState, type JSX } from 'react';
import { characterClient, type CharacterClient } from './character-client';
import { CharacterInspector } from './character-inspector';
import { CharacterRelationPanel } from './character-relation-panel';
import { CharacterGrowthPanel } from './character-growth-panel';
import { CharacterAiPreview } from './character-ai-preview';
import { CharacterAnchorPanel } from './character-anchor-panel';
import { CollabPanel } from '../collab/collab-panel';

type RoleTab = 'dossier' | 'relations' | 'growth' | 'ai' | 'anchor' | 'collab';

const ROLE_TABS: { key: RoleTab; label: string }[] = [
  { key: 'dossier', label: '资料' },
  { key: 'relations', label: '关系' },
  { key: 'growth', label: '成长线' },
  { key: 'ai', label: 'AI 候选' },
  { key: 'anchor', label: '归档影响' },
  { key: 'collab', label: 'AI 协同' }
];

interface Props {
  workId: string;
  /** 深链 ?characterId= 选中角色；为空时提示从画布/列表选择 */
  characterId: string | null;
  chapters?: { id: string; title: string }[] | undefined;
  client?: CharacterClient;
  onOpenChapter?: ((chapterId: string, characterId: string) => void) | undefined;
}

/** 右侧「角色」面板：资料 / 关系 / 成长线 / AI 候选 / 归档影响（T35~T38 集成） */
export function CharacterRolePanel({ workId, characterId, chapters, client = characterClient, onOpenChapter }: Props): JSX.Element {
  const [tab, setTab] = useState<RoleTab>('dossier');

  if (!characterId) {
    return (
      <div className="character-role-panel" role="region" aria-label="角色面板">
        <p className="character-role-hint">在版图中选择角色后，这里会显示资料、关系、成长线与归档影响。</p>
      </div>
    );
  }

  return (
    <div className="character-role-panel" role="region" aria-label="角色面板">
      <div className="character-role-tabs" role="tablist" aria-label="角色面板页签">
        {ROLE_TABS.map((item) => (
          <button key={item.key} type="button" role="tab" aria-selected={tab === item.key}
            className={tab === item.key ? 'is-active' : ''} onClick={() => setTab(item.key)}>
            {item.label}
          </button>
        ))}
      </div>
      <div className="character-role-body" role="tabpanel">
        {tab === 'dossier' ? <CharacterInspector workId={workId} characterId={characterId} client={client} /> : null}
        {tab === 'relations' ? <CharacterRelationPanel workId={workId} characterId={characterId} client={client} /> : null}
        {tab === 'growth' ? (
          <CharacterGrowthPanel workId={workId} characterId={characterId} client={client}
            onOpenChapter={onOpenChapter} />
        ) : null}
        {tab === 'ai' ? <CharacterAiPreview workId={workId} client={client} /> : null}
        {tab === 'anchor' ? (
          <CharacterAnchorPanel workId={workId} characterId={characterId} client={client}
            {...(chapters ? { chapters, chapterIds: chapters.map((chapter) => chapter.id) } : {})} />
        ) : null}
        {tab === 'collab' ? <CollabPanel workId={workId} characterId={characterId} /> : null}
      </div>
    </div>
  );
}
