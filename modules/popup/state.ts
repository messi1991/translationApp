import {
  isHostBlocked,
  resolveTargetLanguage,
  TARGET_LANGUAGES,
  type EngineId,
  type Settings,
} from '@/modules/settings';

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

export type FeatureSwitchKey = keyof Settings['features'];

export interface EngineOptionViewModel {
  id: EngineId;
  label: string;
  ready: boolean;
}

export interface PopupViewModel {
  selectionTranslate: boolean;
  youtubeSubtitles: boolean;
  siteHost: string | null;
  siteSupported: boolean;
  siteEnabled: boolean;
  matchedBlockRule: string | null;
  engineId: EngineId;
  engineLabel: string;
  engineReady: boolean;
  engineOptions: EngineOptionViewModel[];
  targetLanguage: string;
  targetLanguageLabel: string;
}

/** 从当前标签页 URL 提取可管理的 http(s) 主机名（小写）；特权页或非法 URL 返回 null */
export function extractSiteHost(tabUrl: string | undefined | null): string | null {
  if (!tabUrl) return null;
  try {
    const parsed = new URL(tabUrl);
    if (!SUPPORTED_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) {
      return null;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function findMatchingBlockRule(host: string, blockedHosts: readonly string[]): string | null {
  const target = host.toLowerCase().trim();
  for (const entry of blockedHosts) {
    const rule = entry.toLowerCase().trim();
    if (rule && (target === rule || target.endsWith(`.${rule}`))) {
      return entry;
    }
  }
  return null;
}

function formatEngineOption(settings: Settings, engineId: EngineId): EngineOptionViewModel {
  if (engineId === 'edge') {
    return { id: 'edge', label: 'Edge 免费端点', ready: true };
  }
  const cfg = settings.engines['openai-compatible'];
  const hasKey = Boolean(cfg.apiKey.trim());
  const hasBase = Boolean(cfg.baseUrl.trim());
  const model = cfg.model.trim();

  if (!hasKey) {
    return { id: 'openai-compatible', label: 'OpenAI 兼容（未配置密钥）', ready: false };
  }
  if (!hasBase || !model) {
    return { id: 'openai-compatible', label: 'OpenAI 兼容（配置不完整）', ready: false };
  }
  return { id: 'openai-compatible', label: `OpenAI 兼容 · ${model}`, ready: true };
}

/** 将存储配置与当前活动标签页 URL 映射为弹窗展示视图模型 */
export function derivePopupViewModel(
  settings: Settings,
  activeTabUrl?: string | null,
): PopupViewModel {
  const siteHost = extractSiteHost(activeTabUrl);
  const siteSupported = siteHost !== null;
  const matchedBlockRule = siteHost ? findMatchingBlockRule(siteHost, settings.blockedHosts) : null;
  const siteEnabled = siteHost ? !isHostBlocked(siteHost, settings.blockedHosts) : false;
  const engineOptions: EngineOptionViewModel[] = [
    formatEngineOption(settings, 'edge'),
    formatEngineOption(settings, 'openai-compatible'),
  ];
  const engineStatus =
    engineOptions.find((opt) => opt.id === settings.engine) ??
    formatEngineOption(settings, settings.engine);
  const langLabel =
    TARGET_LANGUAGES.find((item) => item.code === settings.targetLanguage)?.label ??
    settings.targetLanguage;

  return {
    selectionTranslate: settings.features.selectionTranslate,
    youtubeSubtitles: settings.features.youtubeSubtitles,
    siteHost,
    siteSupported,
    siteEnabled,
    matchedBlockRule,
    engineId: settings.engine,
    engineLabel: engineStatus.label,
    engineReady: engineStatus.ready,
    engineOptions,
    targetLanguage: settings.targetLanguage,
    targetLanguageLabel: langLabel,
  };
}

/** 切换全局翻译引擎（非法值自动回退 edge），返回新配置 */
export function changeEngine(settings: Settings, engine: string): Settings {
  const next: EngineId = engine === 'openai-compatible' ? 'openai-compatible' : 'edge';
  if (next === settings.engine) return settings;
  return {
    ...settings,
    engine: next,
  };
}

/** 切换全局目标语言（空值自动回退简体中文 zh-CN），返回新配置 */
export function changeTargetLanguage(
  settings: Settings,
  targetLanguage: string,
): Settings {
  const next = resolveTargetLanguage(targetLanguage);
  if (next === settings.targetLanguage) return settings;
  return {
    ...settings,
    targetLanguage: next,
  };
}

/** 切换全局功能开关（划词翻译 / YouTube 双语字幕），返回新配置 */
export function toggleFeatureSwitch(
  settings: Settings,
  feature: FeatureSwitchKey,
  enabled: boolean,
): Settings {
  return {
    ...settings,
    features: {
      ...settings.features,
      [feature]: enabled,
    },
  };
}

/** 切换当前站点启用状态（禁用即写入 blockedHosts，启用即移除命中当前主机名的黑名单项） */
export function toggleSiteEnabled(
  settings: Settings,
  host: string,
  enabled: boolean,
): Settings {
  const normalized = host.toLowerCase().trim();
  if (!normalized) return settings;

  if (!enabled) {
    if (isHostBlocked(normalized, settings.blockedHosts)) {
      return settings;
    }
    return {
      ...settings,
      blockedHosts: [...settings.blockedHosts, normalized],
    };
  }

  return {
    ...settings,
    blockedHosts: settings.blockedHosts.filter((entry) => {
      const rule = entry.toLowerCase().trim();
      return !(normalized === rule || normalized.endsWith(`.${rule}`));
    }),
  };
}
