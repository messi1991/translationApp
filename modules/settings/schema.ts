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

/** 目标语言候选（设置页/弹窗/划词卡片下拉用，默认首项为简体中文） */
export const TARGET_LANGUAGES = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en', label: '英语 (English)' },
  { code: 'ja', label: '日语 (日本語)' },
  { code: 'ko', label: '韩语 (한국어)' },
  { code: 'fr', label: '法语 (Français)' },
  { code: 'de', label: '德语 (Deutsch)' },
  { code: 'es', label: '西班牙语 (Español)' },
  { code: 'ru', label: '俄语 (Русский)' },
] as const;

export type TargetLanguageCode = (typeof TARGET_LANGUAGES)[number]['code'];

/** 空值或仅空白时回退默认目标语言 zh-CN */
export function resolveTargetLanguage(code: string | undefined | null): string {
  const trimmed = code?.trim();
  return trimmed ? trimmed : 'zh-CN';
}

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
