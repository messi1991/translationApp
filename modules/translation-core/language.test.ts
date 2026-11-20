import { describe, expect, it } from 'vitest';
import { describeLanguage, isAutoLanguage } from './language';

describe('语言描述：describeLanguage', () => {
  it('已知码渲染为「母语名（码 / 英文名）」', () => {
    expect(describeLanguage('zh-CN')).toBe('简体中文（zh-CN / Simplified Chinese）');
    expect(describeLanguage('ja')).toBe('日本語（ja / Japanese）');
  });

  it('zh-TW 与 zh-CN 的描述不同', () => {
    expect(describeLanguage('zh-TW')).not.toBe(describeLanguage('zh-CN'));
    expect(describeLanguage('zh-TW')).toContain('繁體中文');
  });

  it('大小写不规范时仍能命中映射', () => {
    expect(describeLanguage('zh-cn')).toContain('简体中文');
    expect(describeLanguage('EN')).toContain('English');
    expect(describeLanguage('PT-br')).toContain('Português do Brasil');
  });

  it('未知码原样返回，不缩成空串', () => {
    expect(describeLanguage('xx-YY')).toBe('xx-YY');
  });

  it('首尾空白被裁掉', () => {
    expect(describeLanguage('  ja  ')).toContain('日本語');
  });
});

describe('是否自动识别：isAutoLanguage', () => {
  it('缺省、auto、detect、空白都算自动识别', () => {
    expect(isAutoLanguage(undefined)).toBe(true);
    expect(isAutoLanguage('')).toBe(true);
    expect(isAutoLanguage('auto')).toBe(true);
    expect(isAutoLanguage('AUTO')).toBe(true);
    expect(isAutoLanguage('detect')).toBe(true);
    expect(isAutoLanguage('  auto ')).toBe(true);
  });

  it('真实语言码不算自动识别', () => {
    expect(isAutoLanguage('en')).toBe(false);
    expect(isAutoLanguage('zh-CN')).toBe(false);
  });
});
