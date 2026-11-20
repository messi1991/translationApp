import { browser } from 'wxt/browser';
import { getSettings, type EngineId, type Settings } from '@/modules/settings';
import { TranslationError, type TranslationErrorCode } from './error';
import { formatTestConnectionError, formatUserError } from './error-messages';
import type { Provider, TranslateInput, TranslationResult } from './provider';
import { createEdgeProvider } from './edge';
import { createOpenAiProvider } from './openai';
import { translateBatch } from './batch';
import { clearCache, withCache } from './cache';
import { createRequestQueue, withRateLimit, type RateLimitOptions } from './rate-limit';

/** 消息类型标识 */
export const TRANSLATE_MESSAGE_TYPE = 'translate';
export const TRANSLATE_MANY_MESSAGE_TYPE = 'translate-many';
export const TEST_CONNECTION_MESSAGE_TYPE = 'test-connection';
export const CLEAR_CACHE_MESSAGE_TYPE = 'clear-cache';

/** 划词/字幕侧发来的翻译请求（to 缺省时用 settings.targetLanguage） */
export interface TranslateMessageData {
  text: string;
  from?: string;
  to?: string;
}

/** 批量翻译请求（字幕场景按批请求以降低调用次数） */
export interface TranslateManyMessageData {
  texts: string[];
  from?: string;
  to?: string;
}

/** 连通性测试请求（engine 缺省时用 settings.engine） */
export interface TestConnectionMessageData {
  engine?: EngineId;
}

/** 统一响应信封：错误不抛异常，以码透传 */
export type MessageResponse =
  | { ok: true; result: TranslationResult }
  | { ok: false; code: TranslationErrorCode; message: string };

/** 批量翻译响应信封 */
export type BatchResponse =
  | { ok: true; result: TranslationResult[] }
  | { ok: false; code: TranslationErrorCode; message: string };

/** 清空缓存的确认响应（无译文数据） */
export type SimpleResponse = { ok: true } | { ok: false; code: TranslationErrorCode; message: string };

/** 所有消息响应的联合，供内部派发使用 */
type AnyResponse = MessageResponse | BatchResponse | SimpleResponse;

/** 信封格式（自定义原生 runtime 消息协议） */
interface MessageEnvelope {
  type:
    | typeof TRANSLATE_MESSAGE_TYPE
    | typeof TRANSLATE_MANY_MESSAGE_TYPE
    | typeof TEST_CONNECTION_MESSAGE_TYPE
    | typeof CLEAR_CACHE_MESSAGE_TYPE;
  data:
    | TranslateMessageData
    | TranslateManyMessageData
    | TestConnectionMessageData
    | Record<string, never>;
}

/** 进程级按引擎隔离的共享并发队列，保证划词与字幕共享同一并发上限 */
const engineQueues = new Map<EngineId, ReturnType<typeof createRequestQueue>>();

function getSharedQueue(engine: EngineId, options?: RateLimitOptions) {
  let queue = engineQueues.get(engine);
  if (!queue) {
    queue = createRequestQueue(options?.maxConcurrency, options?.maxQueueSize);
    engineQueues.set(engine, queue);
  }
  return queue;
}

/** 构造裸引擎（不含缓存与限流） */
function createRawProvider(engine: EngineId, settings: Settings): Provider | null {
  if (engine === 'edge') {
    return createEdgeProvider();
  }
  if (engine === 'openai-compatible') {
    return createOpenAiProvider(settings.engines['openai-compatible']);
  }
  return null;
}

/**
 * 按当前 settings 构造完整装饰链 Provider：
 * 外层二级缓存（命中时不占并发槽与重试）→ 内层限流队列与 429 指数退避 → 底层引擎。
 */
function createConfiguredProvider(
  engine: EngineId,
  settings: Settings,
  rateLimitOptions?: RateLimitOptions,
): Provider | null {
  const raw = createRawProvider(engine, settings);
  if (!raw) return null;
  const guarded = withRateLimit(raw, rateLimitOptions, getSharedQueue(engine, rateLimitOptions));
  return withCache(guarded);
}

/** 处理翻译请求：读配置 → 构造引擎 → 翻译；任何失败都归一为用户安全错误文案 */
async function handleTranslate(
  data: TranslateMessageData,
  rateLimitOptions?: RateLimitOptions,
): Promise<MessageResponse> {
  try {
    const settings = await getSettings();
    const provider = createConfiguredProvider(settings.engine, settings, rateLimitOptions);
    if (!provider) {
      throw new TranslationError('unknown', `引擎 ${settings.engine} 尚未接入`);
    }
    const input: TranslateInput = {
      text: data.text,
      from: data.from,
      to: data.to ?? settings.targetLanguage,
    };
    return { ok: true, result: await provider.translate(input) };
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** 处理批量翻译请求：批量结果无法归为单条信封，失败同样透传码与安全文案 */
async function handleTranslateMany(
  data: TranslateManyMessageData,
  rateLimitOptions?: RateLimitOptions,
): Promise<BatchResponse> {
  try {
    const settings = await getSettings();
    const provider = createConfiguredProvider(settings.engine, settings, rateLimitOptions);
    if (!provider) {
      throw new TranslationError('unknown', `引擎 ${settings.engine} 尚未接入`);
    }
    const result = await translateBatch(provider, {
      texts: data.texts,
      from: data.from,
      to: data.to ?? settings.targetLanguage,
    });
    return { ok: true, result };
  } catch (err) {
    return toErrorResponse(err) as BatchResponse;
  }
}

/** 处理连通性测试请求 */
async function handleTestConnection(
  data: TestConnectionMessageData,
  rateLimitOptions?: RateLimitOptions,
): Promise<MessageResponse> {
  try {
    const settings = await getSettings();
    const engine = data.engine ?? settings.engine;
    const provider = createConfiguredProvider(engine, settings, rateLimitOptions);
    if (!provider) {
      throw new TranslationError('unknown', `引擎 ${engine} 尚未接入`);
    }
    await provider.testConnection();
    return { ok: true, result: { text: '', from: 'auto', engine } };
  } catch (err) {
    return toTestConnectionErrorResponse(err);
  }
}

/** 归一任意异常为脱敏错误信封（绝不向 content/popup 透出堆栈、HTTP 码或上游原始 JSON） */
function toErrorResponse(err: unknown): MessageResponse {
  if (err instanceof TranslationError) {
    return { ok: false, code: err.code, message: formatUserError(err.code) };
  }
  return { ok: false, code: 'unknown', message: formatUserError('unknown') };
}

/** 归一连通性测试异常为设置页安全错误信封 */
function toTestConnectionErrorResponse(err: unknown): MessageResponse {
  if (err instanceof TranslationError) {
    return {
      ok: false,
      code: err.code,
      message: formatTestConnectionError(err.code, err.message),
    };
  }
  return {
    ok: false,
    code: 'unknown',
    message: formatTestConnectionError('unknown'),
  };
}

/** 按消息类型分发处理 */
function dispatchEnvelope(
  message: unknown,
  rateLimitOptions?: RateLimitOptions,
): Promise<AnyResponse> {
  const envelope = message as MessageEnvelope;
  if (envelope?.type === TRANSLATE_MESSAGE_TYPE) {
    return handleTranslate(envelope.data as TranslateMessageData, rateLimitOptions);
  }
  if (envelope?.type === TRANSLATE_MANY_MESSAGE_TYPE) {
    return handleTranslateMany(
      envelope.data as TranslateManyMessageData,
      rateLimitOptions,
    ) as Promise<MessageResponse>;
  }
  if (envelope?.type === CLEAR_CACHE_MESSAGE_TYPE) {
    return handleClearCache();
  }
  if (envelope?.type === TEST_CONNECTION_MESSAGE_TYPE) {
    return handleTestConnection(envelope.data as TestConnectionMessageData, rateLimitOptions);
  }
  return Promise.resolve(toErrorResponse(new TranslationError('unknown', '未知消息类型')));
}

/** background 注册消息处理；返回解绑函数。回调式协议（MV2/MV3/fakeBrowser 兼容） */
export function registerTranslateHandler(rateLimitOptions?: RateLimitOptions): () => void {
  engineQueues.clear();
  const listener = (
    message: unknown,
    _sender: unknown,
    sendResponse: (response: AnyResponse) => void,
  ): boolean => {
    void dispatchEnvelope(message, rateLimitOptions).then(sendResponse);
    return true;
  };
  browser.runtime.onMessage.addListener(listener);
  return () => {
    browser.runtime.onMessage.removeListener(listener);
    engineQueues.clear();
  };
}

/** 调用方 API：请求翻译（content/popup 使用） */
export function requestTranslate(data: TranslateMessageData): Promise<MessageResponse> {
  return browser.runtime.sendMessage({
    type: TRANSLATE_MESSAGE_TYPE,
    data,
  }) as Promise<MessageResponse>;
}

/** 处理清空缓存请求：两层都清，配置不动 */
async function handleClearCache(): Promise<SimpleResponse> {
  try {
    await clearCache({ persistent: true });
    return { ok: true };
  } catch (err) {
    return toErrorResponse(err) as SimpleResponse;
  }
}

/** 调用方 API：清空翻译缓存（options 页使用） */
export function requestClearCache(): Promise<SimpleResponse> {
  return browser.runtime.sendMessage({
    type: CLEAR_CACHE_MESSAGE_TYPE,
    data: {},
  }) as Promise<SimpleResponse>;
}

/** 调用方 API：请求引擎连通性测试（options 页使用） */
export function requestTestConnection(data: TestConnectionMessageData): Promise<MessageResponse> {
  return browser.runtime.sendMessage({
    type: TEST_CONNECTION_MESSAGE_TYPE,
    data,
  }) as Promise<MessageResponse>;
}

/** 调用方 API：批量翻译（字幕场景使用） */
export function requestTranslateMany(data: TranslateManyMessageData): Promise<BatchResponse> {
  return browser.runtime.sendMessage({
    type: TRANSLATE_MANY_MESSAGE_TYPE,
    data,
  }) as Promise<BatchResponse>;
}
