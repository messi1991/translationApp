/**
 * BCP-47 语言码 → 提示词用的自然语言名。
 *
 * 为什么不直接把码塞进 prompt：`zh-CN` 这类码对大模型是歧义输入，
 * 模型可能输出繁体、或干脆回英文解释。给出「简体中文 / Simplified Chinese」
 * 双写名，中英模型都能稳定命中同一语言。
 */

/** 语言码 → [该语言的母语名, 英文名] */
const LANGUAGE_NAMES: Record<string, readonly [string, string]> = {
  'zh-CN': ['简体中文', 'Simplified Chinese'],
  'zh-TW': ['繁體中文', 'Traditional Chinese'],
  'zh-HK': ['繁體中文（香港）', 'Traditional Chinese (Hong Kong)'],
  en: ['English', 'English'],
  ja: ['日本語', 'Japanese'],
  ko: ['한국어', 'Korean'],
  fr: ['Français', 'French'],
  de: ['Deutsch', 'German'],
  es: ['Español', 'Spanish'],
  ru: ['Русский', 'Russian'],
  pt: ['Português', 'Portuguese'],
  'pt-BR': ['Português do Brasil', 'Brazilian Portuguese'],
  it: ['Italiano', 'Italian'],
  ar: ['العربية', 'Arabic'],
  th: ['ไทย', 'Thai'],
  vi: ['Tiếng Việt', 'Vietnamese'],
  id: ['Bahasa Indonesia', 'Indonesian'],
  tr: ['Türkçe', 'Turkish'],
  nl: ['Nederlands', 'Dutch'],
  pl: ['Polski', 'Polish'],
  hi: ['हिन्दी', 'Hindi'],
};

/** auto 语义：由模型自行判断，不能当作真实语言名传给模型 */
export const AUTO_LANGUAGE = 'auto';

/** 判断是否等价于「自动识别」 */
export function isAutoLanguage(code: string | undefined): boolean {
  if (!code) return true;
  const normalized = code.trim().toLowerCase();
  return normalized === '' || normalized === AUTO_LANGUAGE || normalized === 'detect';
}

/**
 * 把语言码渲染为提示词中的语言描述，如 `简体中文（zh-CN / Simplified Chinese）`。
 * 未知码原样返回，避免退化成空串让模型猜。
 */
export function describeLanguage(code: string): string {
  const trimmed = code.trim();
  const names = LANGUAGE_NAMES[trimmed] ?? LANGUAGE_NAMES[normalizeCase(trimmed)];
  if (!names) return trimmed;
  return `${names[0]}（${trimmed} / ${names[1]}）`;
}

/**
 * 容忍大小写不规范的配置值：`zh-cn` → `zh-CN`、`EN` → `en`。
 * 语言主标签小写，子标签（国家/地区）大写。
 */
function normalizeCase(code: string): string {
  const [primary = '', ...rest] = code.split('-');
  return [primary.toLowerCase(), ...rest.map((part) => part.toUpperCase())].join('-');
}
