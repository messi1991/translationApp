import type { TranslationErrorCode } from '@/modules/translation-core';

/** 未知错误码或未归类错误时的兜底文案 */
const FALLBACK_ERROR_TEXT = '翻译失败，请稍后重试';

/** 错误码 → 用户可见文案；不透出内部 message（可能含堆栈或接口字段） */
const ERROR_TEXTS: Record<TranslationErrorCode, string> = {
  network: '网络连接失败，请检查网络后重试',
  'rate-limit': '请求过于频繁，请稍后再试',
  'unsupported-language': '该语言组合暂不支持',
  authentication: '引擎鉴权失败，请检查密钥设置',
  unknown: FALLBACK_ERROR_TEXT,
};

/** 引擎码 → 徽标展示名 */
const ENGINE_LABELS: Record<string, string> = {
  edge: 'Edge',
  'openai-compatible': 'AI',
};

/** 错误码 → 用户可见文案 */
export function errorTextOf(code: TranslationErrorCode | undefined): string {
  return code ? (ERROR_TEXTS[code] ?? FALLBACK_ERROR_TEXT) : FALLBACK_ERROR_TEXT;
}

export function engineLabelOf(engine: string): string {
  return ENGINE_LABELS[engine] ?? engine;
}

