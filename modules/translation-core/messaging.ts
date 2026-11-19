import { browser } from 'wxt/browser';
import { getSettings, type EngineId, type Settings } from '@/modules/settings';
import { TranslationError, type TranslationErrorCode } from './error';
import type { Provider, TranslateInput, TranslationResult } from './provider';
import { createEdgeProvider } from './edge';
import { createOpenAiProvider } from './openai';
import { translateBatch } from './batch';
import { clearCache, withCache } from './cache';

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

/** 构造裸引擎（不含缓存） */
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
 * 按当前 settings 构造带缓存的 Provider。
 * 缓存统一在此处包装，避免下游（划词、字幕）各自处理。
 */
function createConfiguredProvider(
  engine: EngineId,
  settings: Settings,
): Provider | null {
  const raw = createRawProvider(engine, settings);
  return raw ? withCache(raw) : null;
}

/** 处理翻译请求：读配置 → 构造引擎 → 翻译；任何失败都归一为错误码 */
async function handleTranslate(data: TranslateMessageData): Promise<MessageResponse> {
  try {
    const settings = await getSettings();
    const provider = createConfiguredProvider(settings.engine, settings);
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

/** 处理批量翻译请求：批量结果无法归为单条信封，失败同样透传码 */
async function handleTranslateMany(data: TranslateManyMessageData): Promise<BatchResponse> {
  try {
    const settings = await getSettings();
    const provider = createConfiguredProvider(settings.engine, settings);
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
async function handleTestConnection(data: TestConnectionMessageData): Promise<MessageResponse> {
  try {
    const settings = await getSettings();
    const engine = data.engine ?? settings.engine;
    const provider = createConfiguredProvider(engine, settings);
    if (!provider) {
      throw new TranslationError('unknown', `引擎 ${engine} 尚未接入`);
    }
    await provider.testConnection();
    return { ok: true, result: { text: '', from: 'auto', engine } };
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** 归一任意异常为错误信封 */
function toErrorResponse(err: unknown): MessageResponse {
  if (err instanceof TranslationError) {
    return { ok: false, code: err.code, message: err.message };
  }
  return { ok: false, code: 'unknown', message: '翻译失败，请稍后重试' };
}

/** 按消息类型分发处理 */
function dispatchEnvelope(message: unknown): Promise<AnyResponse> {
  const envelope = message as MessageEnvelope;
  if (envelope?.type === TRANSLATE_MESSAGE_TYPE) {
    return handleTranslate(envelope.data as TranslateMessageData);
  }
  if (envelope?.type === TRANSLATE_MANY_MESSAGE_TYPE) {
    return handleTranslateMany(envelope.data as TranslateManyMessageData) as Promise<MessageResponse>;
  }
  if (envelope?.type === CLEAR_CACHE_MESSAGE_TYPE) {
    return handleClearCache();
  }
  if (envelope?.type === TEST_CONNECTION_MESSAGE_TYPE) {
    return handleTestConnection(envelope.data as TestConnectionMessageData);
  }
  return Promise.resolve(toErrorResponse(new TranslationError('unknown', '未知消息类型')));
}

/** background 注册消息处理；返回解绑函数。回调式协议（MV2/MV3/fakeBrowser 兼容） */
export function registerTranslateHandler(): () => void {
  const listener = (
    message: unknown,
    _sender: unknown,
    sendResponse: (response: AnyResponse) => void,
  ): boolean => {
    void dispatchEnvelope(message).then(sendResponse);
    return true;
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
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
