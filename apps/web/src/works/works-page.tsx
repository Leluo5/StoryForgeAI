import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Work } from '@storyforge/contracts';
import { createWork, listWorks, updateWork } from './writing-client';

export function WorksPage() {
  const navigate = useNavigate();
  const [works, setWorks] = useState<Work[]>([]);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [archivingId, setArchivingId] = useState<string>();
  const [error, setError] = useState('');

  const load = useCallback(async (search = '') => {
    try { setWorks(await listWorks(search)); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '作品加载失败'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function submitSearch(event: FormEvent) {
    event.preventDefault();
    await load(query);
  }
  async function submitWork(event: FormEvent) {
    event.preventDefault();
    if (creating) return;
    setCreating(true); setError('');
    try {
      const created = await createWork({ title, description });
      navigate(`/works/${created.work.id}/write/${created.first_chapter_id}?tab=manuscript&panel=chapter`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建失败');
      setCreating(false);
    }
  }
  async function archive(work: Work) {
    if (!window.confirm(`确认归档《${work.title}》？`) || archivingId) return;
    setArchivingId(work.id); setError('');
    try { await updateWork(work.id, { status: 'archived' }); await load(query); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '归档失败'); }
    finally { setArchivingId(undefined); }
  }

  return <main className="works-page">
    <h1>作品库</h1>
    <form onSubmit={submitSearch}>
      <label htmlFor="work-search">搜索作品</label>
      <input id="work-search" value={query} onChange={(event) => setQuery(event.target.value)} />
      <button type="submit">搜索</button>
      <button type="button" onClick={() => setShowForm((value) => !value)}>新建作品</button>
    </form>
    {showForm && <form onSubmit={submitWork}>
      <label htmlFor="work-title">作品名称</label>
      <input id="work-title" required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
      <label htmlFor="work-description">作品简介</label>
      <textarea id="work-description" maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} />
      <button type="submit" disabled={creating}>{creating ? '创建中' : '创建'}</button>
    </form>}
    {error && <p role="alert">{error}</p>}
    <ul aria-label="作品列表">
      {works.map((work) => <li key={work.id}>
        <h2>{work.title}</h2><p>{work.description}</p><span>{work.status === 'active' ? '进行中' : '已归档'}</span>
        <button type="button" disabled={archivingId === work.id} onClick={() => void archive(work)}>
          {archivingId === work.id ? '归档中' : `归档${work.title}`}
        </button>
      </li>)}
    </ul>
  </main>;
}
