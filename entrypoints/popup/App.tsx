import { useEffect, useState } from 'react';
import { getSettings, saveSettings, watchSettings, type Settings } from '@/modules/settings';
import {
  derivePopupViewModel,
  openExtensionOptions,
  queryActiveTabUrl,
  toggleFeatureSwitch,
  toggleSiteEnabled,
  type FeatureSwitchKey,
} from '@/modules/popup';

export interface PopupAppProps {
  /** 获取当前活动标签页 URL；缺省调用 browser.tabs.query */
  getActiveTabUrl?: () => Promise<string | undefined>;
  /** 打开设置页；缺省调用 browser.runtime.openOptionsPage */
  openOptions?: () => Promise<void> | void;
}

const POPUP_STYLES = `
  .popup-root {
    width: 288px;
    padding: 14px 16px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #1f2937;
    box-sizing: border-box;
  }
  .popup-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .popup-title {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .popup-link-btn {
    border: 1px solid #e5e7eb;
    background: #f9fafb;
    color: #374151;
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 6px;
    cursor: pointer;
  }
  .popup-link-btn:hover {
    background: #f3f4f6;
  }
  .popup-status {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 8px 10px;
    margin-bottom: 12px;
    font-size: 12px;
  }
  .popup-status-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .popup-status-row + .popup-status-row {
    margin-top: 4px;
  }
  .popup-muted {
    color: #64748b;
  }
  .popup-engine {
    font-weight: 600;
    color: #0f172a;
  }
  .popup-engine.warn {
    color: #dc2626;
  }
  .popup-section {
    border-top: 1px solid #f1f5f9;
    padding-top: 8px;
    margin-top: 8px;
  }
  .popup-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 0;
    font-size: 13px;
    cursor: pointer;
    user-select: none;
  }
  .popup-toggle input {
    width: 16px;
    height: 16px;
    accent-color: #2563eb;
    cursor: pointer;
  }
  .popup-host {
    font-size: 12px;
    color: #6b7280;
    margin-top: 2px;
    word-break: break-all;
  }
  .popup-error {
    color: #dc2626;
    font-size: 12px;
  }
`;

export default function App({
  getActiveTabUrl = queryActiveTabUrl,
  openOptions = openExtensionOptions,
}: PopupAppProps = {}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tabUrl, setTabUrl] = useState<string | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([getSettings(), getActiveTabUrl()]).then(
      ([loadedSettings, url]) => {
        if (!active) return;
        setSettings(loadedSettings);
        setTabUrl(url);
      },
      () => {
        if (active) setLoadFailed(true);
      },
    );

    const unwatch = watchSettings((next) => {
      if (active) setSettings(next);
    });

    return () => {
      active = false;
      unwatch();
    };
  }, [getActiveTabUrl]);

  if (loadFailed) {
    return (
      <main className="popup-root">
        <style>{POPUP_STYLES}</style>
        <p className="popup-error">配置读取失败，请重新打开弹窗或前往扩展设置页重试。</p>
      </main>
    );
  }

  if (!settings) {
    return (
      <main className="popup-root">
        <style>{POPUP_STYLES}</style>
        <span className="popup-muted">加载中…</span>
      </main>
    );
  }

  const vm = derivePopupViewModel(settings, tabUrl);

  const applySettings = async (next: Settings) => {
    setSettings(next);
    await saveSettings(next);
  };

  const handleFeatureChange = (key: FeatureSwitchKey, enabled: boolean) => {
    void applySettings(toggleFeatureSwitch(settings, key, enabled));
  };

  const handleSiteChange = (enabled: boolean) => {
    if (!vm.siteHost) return;
    void applySettings(toggleSiteEnabled(settings, vm.siteHost, enabled));
  };

  return (
    <main className="popup-root">
      <style>{POPUP_STYLES}</style>

      <header className="popup-header">
        <span className="popup-title">translationApp</span>
        <button
          type="button"
          className="popup-link-btn"
          onClick={() => void openOptions()}
        >
          打开设置
        </button>
      </header>

      <section className="popup-status" aria-label="当前引擎状态">
        <div className="popup-status-row">
          <span className="popup-muted">当前引擎</span>
          <span className={`popup-engine${vm.engineReady ? '' : ' warn'}`}>
            {vm.engineLabel}
          </span>
        </div>
        <div className="popup-status-row">
          <span className="popup-muted">目标语言</span>
          <span>{vm.targetLanguageLabel}</span>
        </div>
      </section>

      <section aria-label="全局开关">
        <label className="popup-toggle">
          <span>划词翻译</span>
          <input
            type="checkbox"
            checked={vm.selectionTranslate}
            onChange={(e) => handleFeatureChange('selectionTranslate', e.target.checked)}
          />
        </label>

        <label className="popup-toggle">
          <span>YouTube 双语字幕</span>
          <input
            type="checkbox"
            checked={vm.youtubeSubtitles}
            onChange={(e) => handleFeatureChange('youtubeSubtitles', e.target.checked)}
          />
        </label>
      </section>

      <section className="popup-section" aria-label="当前站点开关">
        {vm.siteSupported && vm.siteHost ? (
          <>
            <label className="popup-toggle">
              <span>在此站点启用</span>
              <input
                type="checkbox"
                checked={vm.siteEnabled}
                onChange={(e) => handleSiteChange(e.target.checked)}
              />
            </label>
            <div className="popup-host">
              {vm.siteHost}
              {!vm.siteEnabled && vm.matchedBlockRule && vm.matchedBlockRule !== vm.siteHost
                ? `（命中黑名单：${vm.matchedBlockRule}）`
                : ''}
            </div>
          </>
        ) : (
          <div className="popup-host">当前浏览器内置页不支持注入翻译脚本</div>
        )}
      </section>
    </main>
  );
}
