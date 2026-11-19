import { useEffect, useState, type ReactNode } from 'react';
import {
  TARGET_LANGUAGES,
  getSettings,
  saveSettings,
  type EngineId,
  type Settings,
} from '@/modules/settings';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [hostInput, setHostInput] = useState('');

  useEffect(() => {
    void getSettings().then(setSettings);
  }, []);

  if (!settings) return <main className="page">加载中…</main>;

  const update = (patch: Partial<Settings>) => {
    setSaved(false);
    setSettings({ ...settings, ...patch });
  };

  const updateOpenAi = (patch: Partial<Settings['engines']['openai-compatible']>) => {
    update({
      engines: {
        ...settings.engines,
        'openai-compatible': { ...settings.engines['openai-compatible'], ...patch },
      },
    });
  };

  const addHost = () => {
    const raw = hostInput.trim();
    if (!raw) return;
    let host = raw;
    try {
      host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
    } catch {
      /* 非法输入按原文记录 */
    }
    if (!settings.blockedHosts.includes(host)) {
      update({ blockedHosts: [...settings.blockedHosts, host] });
    }
    setHostInput('');
  };

  const removeHost = (host: string) => {
    update({ blockedHosts: settings.blockedHosts.filter((h) => h !== host) });
  };

  const handleSave = async () => {
    await saveSettings(settings);
    setSaved(true);
  };

  return (
    <main className="page">
      <style>{`
        .page { max-width: 560px; margin: 0 auto; padding: 24px; font-family: system-ui; color: #1f2937; }
        .field { display: block; margin-bottom: 16px; }
        .field-label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; color: #4b5563; }
        .field input, .field select { width: 100%; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
        .row { display: flex; gap: 8px; align-items: center; }
        button { padding: 6px 14px; border-radius: 6px; border: 1px solid #d1d5db; background: #f9fafb; cursor: pointer; font-size: 14px; }
        button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
        .badge-list { display: flex; flex-wrap: wrap; gap: 6px; }
        .badge { display: inline-flex; align-items: center; gap: 6px; background: #f3f4f6; border-radius: 999px; padding: 2px 10px; font-size: 13px; }
        .badge button { border: none; background: none; padding: 0 2px; font-size: 13px; color: #6b7280; }
        .hint { font-size: 12px; color: #9ca3af; margin: 4px 0 0; }
        .saved { color: #16a34a; font-size: 13px; margin-left: 8px; }
        h1 { font-size: 18px; } h2 { font-size: 15px; margin-top: 28px; }
      `}</style>

      <h1>translationApp 设置</h1>

      <Field label="目标语言">
        <select
          value={settings.targetLanguage}
          onChange={(e) => update({ targetLanguage: e.target.value })}
        >
          {TARGET_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="翻译引擎">
        <select
          value={settings.engine}
          onChange={(e) => update({ engine: e.target.value as EngineId })}
        >
          <option value="edge">Edge 免费端点（无需配置）</option>
          <option value="openai-compatible">OpenAI 兼容大模型</option>
        </select>
      </Field>

      {settings.engine === 'openai-compatible' && (
        <>
          <Field label="Base URL">
            <input
              type="text"
              placeholder="https://api.deepseek.com/v1"
              value={settings.engines['openai-compatible'].baseUrl}
              onChange={(e) => updateOpenAi({ baseUrl: e.target.value })}
            />
          </Field>
          <Field label="API Key">
            <input
              type="password"
              value={settings.engines['openai-compatible'].apiKey}
              onChange={(e) => updateOpenAi({ apiKey: e.target.value })}
            />
          </Field>
          <Field label="模型">
            <input
              type="text"
              placeholder="deepseek-chat"
              value={settings.engines['openai-compatible'].model}
              onChange={(e) => updateOpenAi({ model: e.target.value })}
            />
            <p className="hint">
              兼容 OpenAI Chat Completions 的服务均可：DeepSeek、Moonshot、OpenAI 等。
            </p>
          </Field>
        </>
      )}

      <h2>功能开关</h2>
      <Field label="划词翻译">
        <input
          type="checkbox"
          checked={settings.features.selectionTranslate}
          onChange={(e) =>
            update({
              features: { ...settings.features, selectionTranslate: e.target.checked },
            })
          }
        />
      </Field>
      <Field label="YouTube 双语字幕">
        <input
          type="checkbox"
          checked={settings.features.youtubeSubtitles}
          onChange={(e) =>
            update({
              features: { ...settings.features, youtubeSubtitles: e.target.checked },
            })
          }
        />
      </Field>

      <h2>站点黑名单</h2>
      <div className="row">
        <input
          type="text"
          placeholder="example.com"
          value={hostInput}
          onChange={(e) => setHostInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addHost()}
        />
        <button type="button" onClick={() => void addHost()}>
          添加
        </button>
      </div>
      <p className="hint">命中黑名单的站点（含子域）不启用划词翻译与字幕。</p>
      <div className="badge-list">
        {settings.blockedHosts.map((host) => (
          <span key={host} className="badge">
            {host}
            <button type="button" onClick={() => removeHost(host)} title="移除">
              ×
            </button>
          </span>
        ))}
      </div>

      <p className="row" style={{ marginTop: 28 }}>
        <button type="button" className="primary" onClick={() => void handleSave()}>
          保存
        </button>
        {saved && <span className="saved">已保存 ✓</span>}
      </p>
    </main>
  );
}
