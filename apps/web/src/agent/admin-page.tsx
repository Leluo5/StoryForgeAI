import { useCallback, useEffect, useState, type JSX } from 'react';
import type {
  SiteConfigResponse,
  UpdateSiteConfigRequest
} from '@storyforge/contracts';
import { getSiteConfig, updateSiteConfig } from './site-config-client';
import { CozeImportPanel } from './coze-import-panel';
import './admin-page.css';

interface CredentialsFields {
  cozeBaseUrl: string;
  cozePat: string;
  flowiseBaseUrl: string;
  flowiseApiKey: string;
  fastgptBaseUrl: string;
  fastgptApiKey: string;
  fastgptDatasetId: string;
  n8nWebhookUrl: string;
  n8nToken: string;
}

const EMPTY_CREDENTIALS: CredentialsFields = {
  cozeBaseUrl: '',
  cozePat: '',
  flowiseBaseUrl: '',
  flowiseApiKey: '',
  fastgptBaseUrl: '',
  fastgptApiKey: '',
  fastgptDatasetId: '',
  n8nWebhookUrl: '',
  n8nToken: ''
};

function fromConfig(config: SiteConfigResponse): {
  siteName: string;
  siteDescription: string;
  theme: 'light' | 'dark';
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  credentials: CredentialsFields;
} {
  const coze = config.platform_credentials.coze ?? {};
  const flowise = config.platform_credentials.flowise ?? {};
  const fastgpt = config.platform_credentials.fastgpt ?? {};
  const n8n = config.platform_credentials.n8n ?? {};
  return {
    siteName: config.site_name,
    siteDescription: config.site_description,
    theme: config.theme,
    llmBaseUrl: config.llm_config.base_url ?? '',
    llmApiKey: config.llm_config.api_key ?? '',
    llmModel: config.llm_config.model ?? '',
    credentials: {
      cozeBaseUrl: coze.base_url ?? '',
      cozePat: coze.pat ?? '',
      flowiseBaseUrl: flowise.base_url ?? '',
      flowiseApiKey: flowise.api_key ?? '',
      fastgptBaseUrl: fastgpt.base_url ?? '',
      fastgptApiKey: fastgpt.api_key ?? '',
      fastgptDatasetId: fastgpt.dataset_id ?? '',
      n8nWebhookUrl: n8n.webhook_url ?? '',
      n8nToken: n8n.token ?? ''
    }
  };
}

/**
 * 后台管理页（/admin）——站点设置（F4 作者级）。
 * 每个作者登录即可访问自己的后台，无独立认证（复用作者 SessionGuard）。
 * 站点设置含站点信息、LLM 配置（完整入库含 api_key）、平台凭据（Coze/Flowise/FastGPT/N8N，作者级接管）。
 */
export function AdminPage(): JSX.Element {
  const [siteName, setSiteName] = useState('');
  const [siteDescription, setSiteDescription] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [llmBaseUrl, setLlmBaseUrl] = useState('');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmModel, setLlmModel] = useState('');
  const [credentials, setCredentials] = useState<CredentialsFields>(EMPTY_CREDENTIALS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await getSiteConfig();
      const values = fromConfig(res.config);
      setSiteName(values.siteName);
      setSiteDescription(values.siteDescription);
      setTheme(values.theme);
      setLlmBaseUrl(values.llmBaseUrl);
      setLlmApiKey(values.llmApiKey);
      setLlmModel(values.llmModel);
      setCredentials(values.credentials);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '站点设置加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const setCred = (key: keyof CredentialsFields, value: string) => {
    setCredentials((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    const input: UpdateSiteConfigRequest = {
      site_name: siteName.trim() || undefined,
      site_description: siteDescription,
      theme,
      llm_config: {
        ...(llmBaseUrl.trim() ? { base_url: llmBaseUrl.trim() } : {}),
        ...(llmApiKey.trim() ? { api_key: llmApiKey.trim() } : {}),
        ...(llmModel.trim() ? { model: llmModel.trim() } : {})
      },
      platform_credentials: {
        coze: {
          ...(credentials.cozeBaseUrl.trim() ? { base_url: credentials.cozeBaseUrl.trim() } : {}),
          ...(credentials.cozePat.trim() ? { pat: credentials.cozePat.trim() } : {})
        },
        flowise: {
          ...(credentials.flowiseBaseUrl.trim() ? { base_url: credentials.flowiseBaseUrl.trim() } : {}),
          ...(credentials.flowiseApiKey.trim() ? { api_key: credentials.flowiseApiKey.trim() } : {})
        },
        fastgpt: {
          ...(credentials.fastgptBaseUrl.trim() ? { base_url: credentials.fastgptBaseUrl.trim() } : {}),
          ...(credentials.fastgptApiKey.trim() ? { api_key: credentials.fastgptApiKey.trim() } : {}),
          ...(credentials.fastgptDatasetId.trim() ? { dataset_id: credentials.fastgptDatasetId.trim() } : {})
        },
        n8n: {
          ...(credentials.n8nWebhookUrl.trim() ? { webhook_url: credentials.n8nWebhookUrl.trim() } : {}),
          ...(credentials.n8nToken.trim() ? { token: credentials.n8nToken.trim() } : {})
        }
      }
    };

    setSaving(true);
    setNotice('');
    setError('');
    try {
      const res = await updateSiteConfig(input);
      const values = fromConfig(res.config);
      setSiteName(values.siteName);
      setSiteDescription(values.siteDescription);
      setTheme(values.theme);
      setLlmBaseUrl(values.llmBaseUrl);
      setLlmApiKey(values.llmApiKey);
      setLlmModel(values.llmModel);
      setCredentials(values.credentials);
      setNotice('已保存');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="admin-page">
      <div className="admin-page__header">
        <h1 className="admin-page__title">站点设置</h1>
        <p className="admin-page__subtitle">配置站点信息、LLM 模型与平台凭据（Coze / Flowise / FastGPT / N8N）</p>
      </div>

      {loading && <p className="admin-page__loading" role="status">正在加载站点设置</p>}
      {error && <p className="admin-page__error" role="alert">{error}</p>}
      {notice && <p className="admin-page__notice" role="status">{notice}</p>}

      {!loading && (
        <div className="admin-page__body">
          <section className="admin-section">
            <h2 className="admin-section__title">站点信息</h2>
            <div className="admin-field">
              <label className="admin-field__label" htmlFor="site-name">站点名称</label>
              <input
                id="site-name"
                className="admin-field__input"
                value={siteName}
                onChange={(e) => setSiteName(e.target.value)}
                placeholder="我的创作站"
              />
            </div>
            <div className="admin-field">
              <label className="admin-field__label" htmlFor="site-desc">站点描述</label>
              <textarea
                id="site-desc"
                className="admin-field__textarea"
                value={siteDescription}
                onChange={(e) => setSiteDescription(e.target.value)}
                rows={3}
                placeholder="一句话介绍你的创作站"
              />
            </div>
            <div className="admin-field">
              <span className="admin-field__label">主题</span>
              <div className="admin-field__options">
                <label className="admin-field__option">
                  <input
                    type="radio"
                    name="theme"
                    value="light"
                    checked={theme === 'light'}
                    onChange={() => setTheme('light')}
                  />
                  <span>浅色</span>
                </label>
                <label className="admin-field__option">
                  <input
                    type="radio"
                    name="theme"
                    value="dark"
                    checked={theme === 'dark'}
                    onChange={() => setTheme('dark')}
                  />
                  <span>深色</span>
                </label>
              </div>
            </div>
          </section>

          <section className="admin-section">
            <h2 className="admin-section__title">LLM 配置</h2>
            <div className="admin-field">
              <label className="admin-field__label" htmlFor="llm-base">接口地址</label>
              <input
                id="llm-base"
                className="admin-field__input"
                value={llmBaseUrl}
                onChange={(e) => setLlmBaseUrl(e.target.value)}
                placeholder="https://..."
              />
            </div>
            <div className="admin-field">
              <label className="admin-field__label" htmlFor="llm-key">API 密钥</label>
              <input
                id="llm-key"
                className="admin-field__input"
                type="password"
                value={llmApiKey}
                onChange={(e) => setLlmApiKey(e.target.value)}
                placeholder="sk-..."
              />
            </div>
            <div className="admin-field">
              <label className="admin-field__label" htmlFor="llm-model">模型</label>
              <input
                id="llm-model"
                className="admin-field__input"
                value={llmModel}
                onChange={(e) => setLlmModel(e.target.value)}
                placeholder="gpt-4o-mini"
              />
            </div>
          </section>

          <section className="admin-section">
            <h2 className="admin-section__title">平台凭据</h2>
            <p className="admin-section__hint">作者级凭据，创作功能优先使用此处配置，未配置时回退环境变量。</p>
            <h3 className="admin-section__subtitle">Coze</h3>
            <div className="admin-field">
              <label className="admin-field__label" htmlFor="coze-base">接口地址</label>
              <input
                id="coze-base"
                className="admin-field__input"
                value={credentials.cozeBaseUrl}
                onChange={(e) => setCred('cozeBaseUrl', e.target.value)}
                placeholder="https://api.coze.cn"
              />
            </div>
            <div className="admin-field">
              <label className="admin-field__label" htmlFor="coze-pat">PAT 令牌</label>
              <input
                id="coze-pat"
                className="admin-field__input"
                type="password"
                value={credentials.cozePat}
                onChange={(e) => setCred('cozePat', e.target.value)}
                placeholder="pat_..."
              />
            </div>

            <h3 className="admin-section__subtitle">Flowise</h3>
            <div className="admin-field">
              <label className="admin-field__label" htmlFor="flowise-base">接口地址</label>
              <input
                id="flowise-base"
                className="admin-field__input"
                value={credentials.flowiseBaseUrl}
                onChange={(e) => setCred('flowiseBaseUrl', e.target.value)}
                placeholder="https://..."
              />
            </div>
            <div className="admin-field">
              <label className="admin-field__label" htmlFor="flowise-key">API 密钥</label>
              <input
                id="flowise-key"
                className="admin-field__input"
                type="password"
                value={credentials.flowiseApiKey}
                onChange={(e) => setCred('flowiseApiKey', e.target.value)}
                placeholder="..."
              />
            </div>

            <h3 className="admin-section__subtitle">FastGPT</h3>
            <div className="admin-field">
              <label className="admin-field__label" htmlFor="fastgpt-base">接口地址</label>
              <input
                id="fastgpt-base"
                className="admin-field__input"
                value={credentials.fastgptBaseUrl}
                onChange={(e) => setCred('fastgptBaseUrl', e.target.value)}
                placeholder="https://..."
              />
            </div>
            <div className="admin-field">
              <label className="admin-field__label" htmlFor="fastgpt-key">API 密钥</label>
              <input
                id="fastgpt-key"
                className="admin-field__input"
                type="password"
                value={credentials.fastgptApiKey}
                onChange={(e) => setCred('fastgptApiKey', e.target.value)}
                placeholder="..."
              />
            </div>
            <div className="admin-field">
              <label className="admin-field__label" htmlFor="fastgpt-dataset">数据集 ID</label>
              <input
                id="fastgpt-dataset"
                className="admin-field__input"
                value={credentials.fastgptDatasetId}
                onChange={(e) => setCred('fastgptDatasetId', e.target.value)}
                placeholder="..."
              />
            </div>

            <h3 className="admin-section__subtitle">N8N</h3>
            <div className="admin-field">
              <label className="admin-field__label" htmlFor="n8n-webhook">Webhook 地址</label>
              <input
                id="n8n-webhook"
                className="admin-field__input"
                value={credentials.n8nWebhookUrl}
                onChange={(e) => setCred('n8nWebhookUrl', e.target.value)}
                placeholder="https://..."
              />
            </div>
            <div className="admin-field">
              <label className="admin-field__label" htmlFor="n8n-token">Token</label>
              <input
                id="n8n-token"
                className="admin-field__input"
                type="password"
                value={credentials.n8nToken}
                onChange={(e) => setCred('n8nToken', e.target.value)}
                placeholder="..."
              />
            </div>
          </section>

          <CozeImportPanel defaultPat={credentials.cozePat} />

          <div className="admin-page__actions">
            <button
              type="button"
              className="admin-page__save"
              onClick={() => void handleSave()}
              disabled={saving}
            >
              {saving ? '保存中…' : '保存设置'}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
