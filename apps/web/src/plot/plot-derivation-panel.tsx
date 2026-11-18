import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import type { DerivationStep } from '@storyforge/contracts';
import { plotClient, type PlotClient, type PlotSessionDetail } from './plot-client';
import { plotErrorMessage, usePlotStore } from './plot-state';

interface Props {
  workId: string;
  client?: PlotClient;
  pollIntervalMs?: number;
}

interface CharacterDraft {
  name: string;
  description: string;
}

const MAX_POLLS = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 推衍面板：配置 → 步进 → 分支 → 候选确认回写（02-技术方案 §6.3） */
export function PlotDerivationPanel({ workId, client = plotClient, pollIntervalMs = 1500 }: Props): JSX.Element {
  const store = usePlotStore();
  const node = store.data.nodes.find((item) => item.id === store.selectedNodeId) ?? null;
  const [detail, setDetail] = useState<PlotSessionDetail | null>(null);
  const [place, setPlace] = useState('');
  const [background, setBackground] = useState('');
  const [timeNode, setTimeNode] = useState('');
  const [premiseIds, setPremiseIds] = useState<string[]>([]);
  const [relatedIds, setRelatedIds] = useState<string[]>([]);
  const [characters, setCharacters] = useState<CharacterDraft[]>([{ name: '', description: '' }]);
  const [randomEnabled, setRandomEnabled] = useState(true);
  const [randomCharacterEnabled, setRandomCharacterEnabled] = useState(true);
  const [splitByStep, setSplitByStep] = useState(false);
  const [placement, setPlacement] = useState<'child' | 'sibling'>('child');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const stoppedRef = useRef(false);
  const pollingRef = useRef(false);

  useEffect(() => {
    stoppedRef.current = false;
    return () => {
      stoppedRef.current = true;
    };
  }, []);

  useEffect(() => {
    if (detail) return;
    setPlace(node?.attributes.place ?? '');
    setTimeNode(node?.attributes.time_point ?? '');
  }, [node?.id, node?.attributes.place, node?.attributes.time_point, detail]);

  const others = store.data.nodes.filter((item) => item.id !== node?.id);

  async function refresh(sessionId: string) {
    const next = await client.getDerivation(workId, sessionId);
    setDetail(next);
    return next;
  }

  async function waitForStep(sessionId: string, previousSteps: number) {
    if (pollingRef.current) return;
    pollingRef.current = true;
    try {
      for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
        await sleep(pollIntervalMs);
        if (stoppedRef.current) return;
        const next = await refresh(sessionId);
        const settled = next.session.status !== 'running' && next.steps.length > previousSteps;
        if (settled || next.session.status === 'failed' || next.session.status === 'finished') {
          setStatus(settled ? `第 ${next.steps.length} 步已生成，已自动暂停` : '推衍任务已结束');
          return;
        }
      }
      setError('推衍任务仍在生成，请稍后刷新');
    } catch (cause) {
      setError(plotErrorMessage(cause));
    } finally {
      pollingRef.current = false;
    }
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!node) return;
    const named = characters.filter((item) => item.name.trim());
    if (!place.trim() || !background.trim()) {
      setError('场所与核心背景为必填项');
      return;
    }
    if (named.length === 0) {
      setError('至少录入 1 个参与角色');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { session } = await client.createDerivation(workId, {
        start_node_id: node.id,
        place: place.trim(),
        background: background.trim(),
        time_node: timeNode.trim() || null,
        premise_node_ids: premiseIds,
        related_node_ids: relatedIds,
        characters: named.map((item) => ({ name: item.name.trim(), description: item.description.trim() })),
        random_enabled: randomEnabled,
        random_character_enabled: randomCharacterEnabled
      });
      setDetail({ session, steps: [], candidates: [] });
      await client.generateStep(workId, session.id);
      await refresh(session.id);
      setStatus('第 1 步生成中…');
      setDetail((prev) => (prev ? { ...prev, session: { ...prev.session, status: 'running' } } : prev));
      void waitForStep(session.id, 0);
    } catch (cause) {
      setError(plotErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function nextStep() {
    if (!detail) return;
    setBusy(true);
    setError('');
    try {
      const previous = detail.steps.length;
      await client.generateStep(workId, detail.session.id);
      setDetail((prev) => (prev ? { ...prev, session: { ...prev.session, status: 'running' } } : prev));
      setStatus(`第 ${previous + 1} 步生成中…`);
      void waitForStep(detail.session.id, previous);
    } catch (cause) {
      setError(plotErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!detail) return;
    setBusy(true);
    try {
      await client.updateDerivation(workId, detail.session.id, { status: 'finished' });
      await refresh(detail.session.id);
      setStatus('推衍已结束，可生成候选节点');
    } catch (cause) {
      setError(plotErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveStep(step: DerivationStep, content: string, chosenBranchId: string | null) {
    if (!detail) return;
    setBusy(true);
    try {
      const { step: saved } = await client.updateStep(workId, detail.session.id, step.step_no, {
        content,
        chosen_branch_id: chosenBranchId
      });
      setDetail((prev) => prev ? {
        ...prev,
        steps: prev.steps.map((item) => (item.step_no === saved.step_no ? saved : item))
      } : prev);
      setStatus(`第 ${saved.step_no} 步已更新`);
    } catch (cause) {
      setError(plotErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function createCandidate() {
    if (!detail) return;
    setBusy(true);
    setError('');
    try {
      await client.createCandidate(workId, detail.session.id, { split_by_step: splitByStep, placement });
      await refresh(detail.session.id);
      setStatus('候选节点已生成，确认后写入剧情树');
    } catch (cause) {
      setError(plotErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function decide(candidateId: string, action: 'confirm' | 'reject') {
    if (!detail) return;
    setBusy(true);
    setError('');
    try {
      if (action === 'reject') {
        await client.rejectCandidate(workId, detail.session.id, candidateId);
        setStatus('候选已拒绝，剧情树保持不变');
      } else {
        const result = await client.confirmCandidate(workId, detail.session.id, candidateId, store.data.version);
        await store.reload();
        const created = result.nodes[0];
        if (created) store.selectNode(created.id);
        setStatus('候选已写入剧情树');
      }
      await refresh(detail.session.id);
    } catch (cause) {
      setError(plotErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!node) {
    return (
      <section className="plot-derivation" aria-label="剧情推衍">
        <p className="plot-hint">先选择起点节点，再发起推衍。</p>
      </section>
    );
  }

  if (!detail) {
    return (
      <section className="plot-derivation" aria-label="剧情推衍">
        <h3>发起推衍 · {node.title}</h3>
        <form className="plot-form" onSubmit={start}>
          <label>
            场所
            <input value={place} maxLength={120} onChange={(event) => setPlace(event.target.value)} required />
          </label>
          <label>
            核心背景
            <textarea value={background} rows={3} maxLength={4000}
              onChange={(event) => setBackground(event.target.value)} required />
          </label>
          <label>
            时间节点
            <input value={timeNode} maxLength={120} onChange={(event) => setTimeNode(event.target.value)} />
          </label>
          <fieldset>
            <legend>前置剧情</legend>
            <div className="plot-checklist">
              {others.length === 0 ? <span className="plot-hint">暂无可选节点</span> : others.map((item) => (
                <label key={item.id} className="plot-check">
                  <input type="checkbox" checked={premiseIds.includes(item.id)}
                    onChange={(event) => setPremiseIds((prev) => event.target.checked
                      ? [...prev, item.id].slice(0, 50)
                      : prev.filter((id) => id !== item.id))} />
                  {item.title}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>关联剧情</legend>
            <div className="plot-checklist">
              {others.length === 0 ? <span className="plot-hint">暂无可选节点</span> : others.map((item) => (
                <label key={item.id} className="plot-check">
                  <input type="checkbox" checked={relatedIds.includes(item.id)}
                    onChange={(event) => setRelatedIds((prev) => event.target.checked
                      ? [...prev, item.id].slice(0, 50)
                      : prev.filter((id) => id !== item.id))} />
                  {item.title}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>参与角色（至少 1 个）</legend>
            {characters.map((character, index) => (
              <div key={index} className="plot-character-row">
                <input aria-label={`角色 ${index + 1} 名称`} value={character.name} maxLength={60} placeholder="角色名"
                  onChange={(event) => setCharacters((prev) => prev.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, name: event.target.value } : item))} />
                <input aria-label={`角色 ${index + 1} 设定`} value={character.description} maxLength={200} placeholder="一句话设定"
                  onChange={(event) => setCharacters((prev) => prev.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, description: event.target.value } : item))} />
                {characters.length > 1 ? (
                  <button type="button" aria-label={`移除角色 ${index + 1}`}
                    onClick={() => setCharacters((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}>−</button>
                ) : null}
              </div>
            ))}
            <button type="button" disabled={characters.length >= 20}
              onClick={() => setCharacters((prev) => [...prev, { name: '', description: '' }])}>添加角色</button>
          </fieldset>
          <label className="plot-check">
            <input type="checkbox" checked={randomEnabled} onChange={(event) => setRandomEnabled(event.target.checked)} />
            随机意外事件
          </label>
          <label className="plot-check">
            <input type="checkbox" checked={randomCharacterEnabled}
              onChange={(event) => setRandomCharacterEnabled(event.target.checked)} />
            随机新角色入场
          </label>
          <button type="submit" disabled={busy}>开始推衍</button>
        </form>
        {error ? <p className="plot-error" role="alert">{error}</p> : null}
      </section>
    );
  }

  const lastStep = detail.steps.length > 0 ? detail.steps[detail.steps.length - 1]! : null;
  const settled = detail.session.status !== 'running';

  return (
    <section className="plot-derivation" aria-label="剧情推衍">
      <h3>推衍会话 · {node.title}</h3>
      <p className="plot-hint" role="status">
        状态：{sessionStatusLabel(detail.session.status)} · 已完成 {detail.steps.length} 步
      </p>
      {status ? <p className="plot-notice" role="status">{status}</p> : null}

      <ol className="plot-step-list">
        {detail.steps.map((step) => (
          <li key={step.id} className="plot-step">
            <h4>第 {step.step_no} 步</h4>
            {step.event ? <p className="plot-step-event">随机事件：{step.event.title}</p> : null}
            {step.new_characters.length > 0 ? (
              <p className="plot-step-event">新角色：{step.new_characters.map((item) => item.name).join('、')}</p>
            ) : null}
            <StepEditor step={step} disabled={busy} onSave={saveStep} />
          </li>
        ))}
      </ol>

      <div className="plot-form-actions">
        <button type="button" onClick={nextStep} disabled={busy || !settled}>生成下一步</button>
        <button type="button" onClick={finish} disabled={busy || !settled || !lastStep}>结束推衍</button>
      </div>

      {lastStep && settled ? (
        <section className="plot-subsection" aria-label="候选回写">
          <h4>候选节点</h4>
          <label className="plot-check">
            <input type="checkbox" checked={splitByStep} onChange={(event) => setSplitByStep(event.target.checked)} />
            按步拆分多个节点（默认合并为 1 个）
          </label>
          <fieldset>
            <legend>挂接位置</legend>
            <label className="plot-check">
              <input type="radio" name="plot-placement" checked={placement === 'child'}
                onChange={() => setPlacement('child')} />
              作为起点节点的子节点
            </label>
            <label className="plot-check">
              <input type="radio" name="plot-placement" checked={placement === 'sibling'}
                onChange={() => setPlacement('sibling')} />
              作为起点节点的兄弟节点
            </label>
          </fieldset>
          <button type="button" onClick={createCandidate} disabled={busy}>生成候选</button>
          <ul className="plot-candidate-list">
            {detail.candidates.map((candidate) => (
              <li key={candidate.id}>
                <span>{candidate.payload.nodes.map((item) => item.title).join(' / ')}</span>
                <span className="plot-link-type">
                  {candidate.placement === 'child' ? '子节点' : '兄弟节点'} · {candidateStatusLabel(candidate.status)}
                </span>
                {candidate.status === 'pending' ? (
                  <span className="plot-form-actions">
                    <button type="button" disabled={busy} onClick={() => void decide(candidate.id, 'confirm')}>确认回写</button>
                    <button type="button" disabled={busy} onClick={() => void decide(candidate.id, 'reject')}>拒绝</button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {error ? <p className="plot-error" role="alert">{error}</p> : null}
    </section>
  );
}

function StepEditor({ step, disabled, onSave }: {
  step: DerivationStep;
  disabled: boolean;
  onSave: (step: DerivationStep, content: string, chosenBranchId: string | null) => void;
}): JSX.Element {
  const [content, setContent] = useState(step.content);
  const [chosen, setChosen] = useState<string | null>(step.chosen_branch_id);
  return (
    <div className="plot-step-editor">
      <label>
        本步内容
        <textarea value={content} rows={4} onChange={(event) => setContent(event.target.value)} />
      </label>
      <fieldset>
        <legend>分支选择</legend>
        {step.branches.map((branch) => (
          <label key={branch.id} className="plot-check">
            <input type="radio" name={`branch-${step.id}`} checked={chosen === branch.id}
              onChange={() => setChosen(branch.id)} />
            {branch.label}
            {branch.description ? <span className="plot-hint">（{branch.description}）</span> : null}
          </label>
        ))}
      </fieldset>
      <button type="button" disabled={disabled} onClick={() => onSave(step, content, chosen)}>保存本步</button>
    </div>
  );
}

function sessionStatusLabel(status: PlotSessionDetail['session']['status']): string {
  return {
    idle: '待开始',
    running: '生成中',
    paused: '已暂停',
    finished: '已结束',
    failed: '失败'
  }[status];
}

function candidateStatusLabel(status: PlotSessionDetail['candidates'][number]['status']): string {
  return { pending: '待确认', confirmed: '已回写', rejected: '已拒绝' }[status];
}
