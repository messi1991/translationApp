import { formatUserError, type TranslationErrorCode } from '@/modules/translation-core';

/** 引擎码 → 徽标展示名 */
const ENGINE_LABELS: Record<string, string> = {
  edge: 'Edge',
  'openai-compatible': 'AI',
};

/** 错误码 → 用户可见文案（统一委托给 translation-core 文案表，不透出堆栈或内部字段） */
export function errorTextOf(code: TranslationErrorCode | undefined): string {
  return formatUserError(code);
}

export function engineLabelOf(engine: string): string {
  return ENGINE_LABELS[engine] ?? engine;
}
