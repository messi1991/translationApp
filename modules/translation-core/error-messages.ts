import type { TranslationErrorCode } from './error';

/** 划词与通用翻译场景的用户可见错误文案表（绝不包含堆栈、HTTP 码或内部接口字段） */
export const USER_ERROR_MESSAGES: Record<TranslationErrorCode, string> = {
  network: '网络连接失败，请检查网络后重试',
  'rate-limit': '请求过于频繁，请稍后再试',
  'unsupported-language': '该语言组合暂不支持',
  authentication: '引擎鉴权失败，请检查密钥设置',
  unknown: '翻译失败，请稍后重试',
};

/** 设置页「测试连接」场景的用户可见错误文案表 */
export const TEST_CONNECTION_ERROR_MESSAGES: Record<TranslationErrorCode, string> = {
  authentication: '鉴权失败，请检查 API Key 是否正确',
  'rate-limit': '请求过于频繁，请稍后重试',
  network: '网络不可达，请检查网络或 Base URL',
  'unsupported-language': '该引擎不支持当前语言对',
  unknown: '连接失败，请检查接口地址与模型配置',
};

const SAFE_CONFIG_HINTS: Record<string, string> = {
  '未配置 API Key': '未配置 API Key，请先填写密钥后再测试',
  '未配置 Base URL': '未配置 Base URL，请先填写接口地址',
  '未配置模型名称': '未配置模型名称，请先填写模型',
};

/** 检测文案是否意外混入调用栈、HTTP 原始状态行、JSON 结构或密钥特征 */
const INTERNAL_LEAK_PATTERNS = [
  /\bat\s+\S+\s*\(/, // JS stack frame: at fn (file:1:2)
  /\.ts:\d+|\.js:\d+/, // 源码行号
  /HTTP\s+\d{3}/i, // HTTP 429 / HTTP 500
  /[{}[\]]/, // JSON 括号或内部结构
  /\bsk-[A-Za-z0-9_-]{3,}/, // OpenAI 风格密钥
  /\b(?:TypeError|SyntaxError|ReferenceError|DOMException|TranslationError)\b/,
];

export function hasInternalErrorLeak(text: string): boolean {
  return INTERNAL_LEAK_PATTERNS.some((re) => re.test(text));
}

/** 将错误码映射为用户可见翻译错误提示 */
export function formatUserError(code: TranslationErrorCode | undefined): string {
  if (!code) return USER_ERROR_MESSAGES.unknown;
  return USER_ERROR_MESSAGES[code] ?? USER_ERROR_MESSAGES.unknown;
}

/** 将连通性测试结果映射为用户可见提示（保留白名单内的本地未填项指引，拦截一切外部原始错误体） */
export function formatTestConnectionError(
  code: TranslationErrorCode | undefined,
  rawMessage?: string,
): string {
  if (rawMessage && SAFE_CONFIG_HINTS[rawMessage]) {
    return SAFE_CONFIG_HINTS[rawMessage]!;
  }
  if (!code) return TEST_CONNECTION_ERROR_MESSAGES.unknown;
  return TEST_CONNECTION_ERROR_MESSAGES[code] ?? TEST_CONNECTION_ERROR_MESSAGES.unknown;
}
