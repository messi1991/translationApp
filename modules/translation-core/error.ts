/** 翻译失败分类错误码（对外透传与 UI 文案分支用） */
export const TRANSLATION_ERROR_CODES = [
  'network',
  'rate-limit',
  'unsupported-language',
  'authentication',
  'unknown',
] as const;

export type TranslationErrorCode = (typeof TRANSLATION_ERROR_CODES)[number];

/** 统一翻译错误，携带可分类码 */
export class TranslationError extends Error {
  readonly code: TranslationErrorCode;

  constructor(code: TranslationErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'TranslationError';
    this.code = code;
    this.cause = cause;
  }
}
