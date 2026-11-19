/** 翻译引擎标识 */
export type EngineId = 'edge' | 'openai-compatible';

/** OpenAI 兼容引擎配置（用户自带 key，仅存本地） */
export interface OpenAiCompatibleConfig {
  /** 形如 https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface Settings {
  /** 翻译目标语言，BCP-47 代码 */
  targetLanguage: string;
  engine: EngineId;
  engines: {
    'openai-compatible': OpenAiCompatibleConfig;
  };
  /** 功能开关 */
  features: {
    selectionTranslate: boolean;
    youtubeSubtitles: boolean;
  };
  /** 站点黑名单：主机名列表，如 ['github.com']，匹配自身及其子域 */
  blockedHosts: string[];
}

/** 目标语言候选（设置页下拉用） */
export const TARGET_LANGUAGES = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'ru', label: 'Русский' },
] as const;

export const DEFAULT_SETTINGS: Settings = {
  targetLanguage: 'zh-CN',
  engine: 'edge',
  engines: {
    'openai-compatible': { baseUrl: '', apiKey: '', model: '' },
  },
  features: {
    selectionTranslate: true,
    youtubeSubtitles: true,
  },
  blockedHosts: [],
};
