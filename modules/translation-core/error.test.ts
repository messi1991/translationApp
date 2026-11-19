import { describe, expect, it } from 'vitest';
import { TRANSLATION_ERROR_CODES, TranslationError } from './error';

describe('错误分类', () => {
  it('错误码枚举覆盖四分支与兜底', () => {
    expect(TRANSLATION_ERROR_CODES).toContain('network');
    expect(TRANSLATION_ERROR_CODES).toContain('rate-limit');
    expect(TRANSLATION_ERROR_CODES).toContain('unsupported-language');
    expect(TRANSLATION_ERROR_CODES).toContain('authentication');
    expect(TRANSLATION_ERROR_CODES).toContain('unknown');
  });

  it('TranslationError 携带码与原因', () => {
    const cause = new Error('boom');
    const err = new TranslationError('network', '网络请求失败', cause);
    expect(err.code).toBe('network');
    expect(err.message).toBe('网络请求失败');
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TranslationError');
  });
});
