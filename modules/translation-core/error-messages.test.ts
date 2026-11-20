import { describe, expect, it } from 'vitest';
import { TRANSLATION_ERROR_CODES } from './error';
import {
  TEST_CONNECTION_ERROR_MESSAGES,
  USER_ERROR_MESSAGES,
  formatTestConnectionError,
  formatUserError,
  hasInternalErrorLeak,
} from './error-messages';

describe('用户可见错误文案表（T13）', () => {
  it('覆盖全部标准错误码，且每条文案均为纯自然语言中文、不含堆栈或内部字段', () => {
    for (const code of TRANSLATION_ERROR_CODES) {
      const msg = formatUserError(code);
      expect(msg.length).toBeGreaterThan(4);
      expect(USER_ERROR_MESSAGES[code]).toBe(msg);
      expect(hasInternalErrorLeak(msg)).toBe(false);

      const testConnMsg = formatTestConnectionError(code);
      expect(testConnMsg.length).toBeGreaterThan(4);
      expect(TEST_CONNECTION_ERROR_MESSAGES[code]).toBe(testConnMsg);
      expect(hasInternalErrorLeak(testConnMsg)).toBe(false);
    }

    // 未定义或异常错误码统一回落到 unknown 兜底文案
    expect(formatUserError(undefined)).toBe(USER_ERROR_MESSAGES.unknown);
  });

  it('即使上游原始错误含堆栈、HTTP 状态码、JSON 字段或密钥前缀，formatTestConnectionError 也绝不透出', () => {
    const dirtyRaw =
      'Error: Request failed HTTP 401 {"error":{"code":"invalid_api_key","param":"apiKey"}} sk-secret123\n    at fetch (openai.ts:42:11)';
    const safe = formatTestConnectionError('authentication', dirtyRaw);
    expect(safe).not.toContain('sk-secret');
    expect(safe).not.toContain('at fetch');
    expect(safe).not.toContain('invalid_api_key');
    expect(hasInternalErrorLeak(safe)).toBe(false);

    // 但对于安全的本地配置缺失提示（如「未配置 API Key」「未配置 Base URL」），保留明确指引
    expect(formatTestConnectionError('authentication', '未配置 API Key')).toBe(
      '未配置 API Key，请先填写密钥后再测试',
    );
    expect(formatTestConnectionError('unknown', '未配置 Base URL')).toBe(
      '未配置 Base URL，请先填写接口地址',
    );
    expect(formatTestConnectionError('unknown', '未配置模型名称')).toBe(
      '未配置模型名称，请先填写模型',
    );
  });
});
