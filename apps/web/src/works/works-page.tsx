import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Work } from '@storyforge/contracts';
import { Badge, Button, Card, Input, Modal, Spinner, Textarea } from '@storyforge/ui';
import { createWork, getTree, listWorks, updateWork } from './writing-client';
import './works-page.css';

function formatDate(value: Work['created_at']): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function WorksPage() {
  const navigate = useNavigate();
  const [works, setWorks] = useState<Work[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [archivingId, setArchivingId] = useState<string>();
  const [openingId, setOpeningId] = useState<string>();
  const [error, setError] = useState('');

  const load = useCallback(async (search = '') => {
    try {
      setWorks(await listWorks(search));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '作品加载失败');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function submitSearch(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    await load(query);
  }
  function openCreate() {
    setShowForm(true);
    setTitle('');
    setDescription('');
    setError('');
  }
  async function submitWork(event: FormEvent) {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    setError('');
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
    setArchivingId(work.id);
    setError('');
    try {
      await updateWork(work.id, { status: 'archived' });
      await load(query);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '归档失败');
    } finally {
      setArchivingId(undefined);
    }
  }
  // 进入工作台：解析首章 id 生成有效深链；无章节时先引导创建首章
  async function openWork(work: Work) {
    if (openingId) return;
    setOpeningId(work.id);
    setError('');
    try {
      const tree = await getTree(work.id);
      const first = [...tree.chapters].sort((a, b) => a.position - b.position)[0];
      if (first) {
        navigate(`/works/${work.id}/write/${first.id}?tab=manuscript&panel=chapter`);
      } else {
        setError(`《${work.title}》还没有章节，请先在工作台里创建`);
        navigate(`/works/${work.id}/write/`, { replace: true });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '进入作品失败');
    } finally {
      setOpeningId(undefined);
    }
  }

  return (
    <main className="works-page">
      <div className="works-page__header">
        <div>
          <h1 className="works-page__title">作品库</h1>
          <p className="works-page__subtitle">管理你的小说作品，继续或开启新的创作</p>
        </div>
        <div className="works-toolbar">
          <form className="works-toolbar__search" onSubmit={submitSearch}>
            <Input
              id="work-search"
              name="q"
              placeholder="搜索作品…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </form>
          <Button variant="ghost" onClick={() => navigate('/arkclaw')}>ArkClaw 验证</Button>
          <Link to="/knowledge"><Button variant="secondary">知识库</Button></Link>
          <Button variant="primary" onClick={openCreate}>新建作品</Button>
        </div>
      </div>

      {error ? <p className="works-error" role="alert">{error}</p> : null}

      {loading ? (
        <div className="works-empty">
          <Spinner size="lg" label="加载中…" />
        </div>
      ) : (
        <ul className="works-grid" aria-label="作品列表">
          {works.length === 0 ? (
            <li className="works-empty">还没有作品，点击「新建作品」开始你的故事</li>
          ) : works.map((work) => (
            <li key={work.id}>
              <Card
                className="works-card"
                interactive={work.status === 'active'}
                onClick={() => { if (work.status === 'active') void openWork(work); }}
                header={
                  <div className="works-card__head">
                    <h2 className="works-card__title">{work.title}</h2>
                    <Badge variant={work.status === 'active' ? 'brand' : 'default'}>
                      {work.status === 'active' ? '进行中' : '已归档'}
                    </Badge>
                  </div>
                }
              >
                <p className="works-card__desc">{work.description || '暂无简介'}</p>
                <div className="works-card__meta">
                  <span className="works-card__date">创建于 {formatDate(work.created_at)}</span>
                </div>
                <div className="works-card__footer">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={openingId === work.id || work.status !== 'active'}
                    onClick={(event) => {
                      event.stopPropagation();
                      void openWork(work);
                    }}
                  >
                    {openingId === work.id ? '进入中…' : '进入工作台'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`归档${work.title}`}
                    disabled={archivingId === work.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      void archive(work);
                    }}
                  >
                    {archivingId === work.id ? '归档中' : '归档'}
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title="新建作品"
        footer={
          <div className="works-form__actions">
            <Button variant="secondary" onClick={() => setShowForm(false)} disabled={creating}>取消</Button>
            <Button
              variant="primary"
              type="submit"
              form="works-create-form"
              loading={creating}
            >
              {creating ? '创建中' : '创建'}
            </Button>
          </div>
        }
      >
        <form id="works-create-form" className="works-form" onSubmit={submitWork}>
          <Input
            id="work-title"
            name="title"
            label="作品名称"
            required
            maxLength={120}
            placeholder="例如：山海秘闻录"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Textarea
            id="work-description"
            name="description"
            label="作品简介（可选）"
            maxLength={2000}
            rows={4}
            placeholder="一句话介绍你的故事…"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </form>
      </Modal>
    </main>
  );
}
