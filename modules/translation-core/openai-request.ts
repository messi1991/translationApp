import { TranslationError } from './error';

/** 默认请求超时（毫秒）：大模型首字延迟明显高于 Edge 端点 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 调用 openai 兼容端点所需的最小配置 */
export interface OpenAiRequestConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 请求超时，缺省用 DEFAULT_TIMEOUT_MS */
  timeoutMs?: number;
}

/** chat completions 响应中我们关心的字段 */
export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

/** 错误响应中可能携带的服务端说明 */
interface ErrorResponseBody {
  error?: { message?: unknown };
}

const TIMEOUT_MARK = '超时';

/** 去掉 baseUrl 末尾斜杠，避免拼接出双斜杠 */
const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');

/** 校验必填配置，缺失时在发请求前就抛错（鉴权项优先提示） */
export function assertConfigured(config: OpenAiRequestConfig): void {
  if (!config.apiKey.trim()) {
    throw new TranslationError('authentication', '未配置 API Key');
  }
  if (!config.baseUrl.trim()) {
    throw new TranslationError('unknown', '未配置 Base URL');
  }
  if (!config.model.trim()) {
    throw new TranslationError('unknown', '未配置模型名称');
  }
}

/** 把 HTTP 状态码映射为错误码：鉴权与限流单独分类，其余兜底 */
function classifyHttpFailure(status: number, detail: string): TranslationError {
  const suffix = detail ? `：${detail}` : '';
  if (status === 401 || status === 403) {
    return new TranslationError('authentication', `鉴权失败（HTTP ${status}）${suffix}`);
  }
  if (status === 429) {
    return new TranslationError('rate-limit', `请求过于频繁（HTTP ${status}）${suffix}`);
  }
  return new TranslationError('unknown', `请求失败（HTTP ${status}）${suffix}`);
}

/** 尽量提取服务端错误说明，提取不到返回空串 */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as ErrorResponseBody;
    const message = body?.error?.message;
    return typeof message === 'string' ? message : '';
  } catch {
    return '';
  }
}

/** 判断错误是否由我们自己的超时中断触发 */
function isTimeoutAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError';
}

/** 解析成功响应，取出助手回复的原始内容 */
async function readAssistantContent(response: Response): Promise<string> {
  let data: ChatCompletionResponse;
  try {
    data = (await response.json()) as ChatCompletionResponse;
  } catch (cause) {
    throw new TranslationError('unknown', '响应不是合法 JSON（可能误开了流式输出）', cause);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new TranslationError('unknown', '模型未返回译文');
  }
  return content;
}

/** 发起一次 chat completions 请求，返回助手回复的原始内容字符串 */
export async function requestChatCompletion(
  config: OpenAiRequestConfig,
  messages: ChatMessage[],
): Promise<string> {
  assertConfigured(config);

  const controller = new AbortController();
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, messages, stream: false, temperature: 0 }),
      signal: controller.signal,
    });
  } catch (cause) {
    if (isTimeoutAbort(cause)) {
      throw new TranslationError('network', `请求${TIMEOUT_MARK}（${timeoutMs}ms）`, cause);
    }
    throw new TranslationError('network', '网络请求失败', cause);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw classifyHttpFailure(response.status, await readErrorDetail(response));
  }
  return readAssistantContent(response);
}
