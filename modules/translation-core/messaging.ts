import { browser } from 'wxt/browser';
import { getSettings, type EngineId } from '@/modules/settings';
import { TranslationError, type TranslationErrorCode } from './error';
import type { Provider, TranslateInput, TranslationResult } from './provider';
import { createEdgeProvider } from './edge';

/** 消息类型标识 */
export const TRANSLATE_MESSAGE_TYPE = 'translate';
export const TEST_CONNECTION_MESSAGE_TYPE = 'test-connection';

/** 划词/字幕侧发来的翻译请求（to 缺省时用 settings.targetLanguage） */
export interface TranslateMessageData {
  text: string;
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

/** 信封格式（自定义原生 runtime 消息协议） */
interface MessageEnvelope {
  type: typeof TRANSLATE_MESSAGE_TYPE | typeof TEST_CONNECTION_MESSAGE_TYPE;
  data: TranslateMessageData | TestConnectionMessageData;
}

/** 按当前 settings 的引擎构造 Provider；未实现的引擎返回 null（T4 交付 OpenAI 兼容） */
function createConfiguredProvider(engine: EngineId): Provider | null {
  if (engine === 'edge') {
    return createEdgeProvider();
  }
  return null;
}

/** 处理翻译请求：读配置 → 构造引擎 → 翻译；任何失败都归一为错误码 */
async function handleTranslate(data: TranslateMessageData): Promise<MessageResponse> {
  try {
    const settings = await getSettings();
    const provider = createConfiguredProvider(settings.engine);
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

/** 处理连通性测试请求 */
async function handleTestConnection(data: TestConnectionMessageData): Promise<MessageResponse> {
  try {
    const settings = await getSettings();
    const provider = createConfiguredProvider(data.engine ?? settings.engine);
    if (!provider) {
      throw new TranslationError('unknown', `引擎 ${data.engine ?? settings.engine} 尚未接入`);
    }
    await provider.testConnection();
    return { ok: true, result: { text: '', from: 'auto', engine: data.engine ?? settings.engine } };
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
function dispatchEnvelope(message: unknown): Promise<MessageResponse> {
  const envelope = message as MessageEnvelope;
  if (envelope?.type === TRANSLATE_MESSAGE_TYPE) {
    return handleTranslate(envelope.data as TranslateMessageData);
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
    sendResponse: (response: MessageResponse) => void,
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

/** 调用方 API：请求引擎连通性测试（options 页使用） */
export function requestTestConnection(data: TestConnectionMessageData): Promise<MessageResponse> {
  return browser.runtime.sendMessage({
    type: TEST_CONNECTION_MESSAGE_TYPE,
    data,
  }) as Promise<MessageResponse>;
}
