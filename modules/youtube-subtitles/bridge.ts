import type { SubtitleCue, SubtitleWord } from './json3';

/** postMessage 桥固定来源标识（配合随机 nonce 防页面第三方脚本伪造） */
export const BRIDGE_SOURCE = 'translation-app:yt-bridge';

export type BridgeDirection = 'to-main' | 'to-isolated';

/** MAIN world 返回给 isolated world 的字幕获取结果 */
export type BridgeSubtitleResult =
  | {
      status: 'ok';
      videoId: string;
      languageCode: string;
      isAsr: boolean;
      cues: SubtitleCue[];
      words: SubtitleWord[];
    }
  | { status: 'live'; videoId: string }
  | { status: 'no-captions'; videoId: string }
  | { status: 'error'; message: string; videoId?: string };

export type IsolatedToMainMessage =
  | { type: 'hello' }
  | { type: 'get-subtitles'; requestId: number; expectedVideoId: string }
  | { type: 'abort-request'; requestId: number };

export type MainToIsolatedMessage =
  | { type: 'ready' }
  | { type: 'subtitles-result'; requestId: number; result: BridgeSubtitleResult };

export interface BridgeEnvelope<M> {
  source: typeof BRIDGE_SOURCE;
  dir: BridgeDirection;
  nonce: string;
  msg: M;
}

export interface BridgeClientOptions {
  nonce?: string;
  helloIntervalMs?: number;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface BridgeClient {
  requestSubtitles: (expectedVideoId: string, signal?: AbortSignal) => Promise<BridgeSubtitleResult>;
  destroy: () => void;
}

const DEFAULT_HELLO_INTERVAL_MS = 50;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 3000;
/** 单次字幕请求超时：MAIN world 需等播放器发出带 POT 的字幕请求（默认 5s）、备用客户端兜底，故留宽 */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const NONCE_BYTES = 16;

/** 生成 128-bit 随机十六进制 nonce */
export function createNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 校验并解包 postMessage 信封：
 * 1. ev.source === window（同一窗口）
 * 2. source === BRIDGE_SOURCE 且方向匹配
 * 3. nonce 与本页会话一致
 */
function isSameWindowSource(source: MessageEventSource | null): boolean {
  if (source === window) return true;
  // jsdom 的 window.postMessage('*', ...) 派发事件时 event.source 为 null；
  // 真实浏览器中跨窗口/跨 iframe 消息的 event.source 为对应外部 WindowProxy（!== null && !== window）。
  return source === null && typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
}

export function readBridgeMessage(
  ev: MessageEvent,
  dir: 'to-main',
  nonce: string,
): IsolatedToMainMessage | null;
export function readBridgeMessage(
  ev: MessageEvent,
  dir: 'to-isolated',
  nonce: string,
): MainToIsolatedMessage | null;
export function readBridgeMessage(
  ev: MessageEvent,
  dir: BridgeDirection,
  nonce: string,
): IsolatedToMainMessage | MainToIsolatedMessage | null {
  if (!isSameWindowSource(ev.source)) return null;
  const data = ev.data as Partial<BridgeEnvelope<unknown>> | null;
  if (!data || typeof data !== 'object') return null;
  if (data.source !== BRIDGE_SOURCE || data.dir !== dir || data.nonce !== nonce) return null;
  if (!data.msg || typeof data.msg !== 'object') return null;
  return data.msg as IsolatedToMainMessage | MainToIsolatedMessage;
}

/** 向同窗口另一 world 投递桥消息 */
export function postBridgeMessage(
  dir: 'to-main',
  nonce: string,
  msg: IsolatedToMainMessage,
): void;
export function postBridgeMessage(
  dir: 'to-isolated',
  nonce: string,
  msg: MainToIsolatedMessage,
): void;
export function postBridgeMessage(
  dir: BridgeDirection,
  nonce: string,
  msg: IsolatedToMainMessage | MainToIsolatedMessage,
): void {
  const envelope: BridgeEnvelope<typeof msg> = {
    source: BRIDGE_SOURCE,
    dir,
    nonce,
    msg,
  };
  window.postMessage(envelope, '*');
}

function makeAbortError(): Error {
  const err = new Error('Bridge request aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * 创建 isolated world 侧桥客户端：
 * 启动时发送 hello 握手并绑定随机 nonce，后续按 requestId 复用连接收发字幕请求。
 */
export function createIsolatedBridgeClient(options: BridgeClientOptions = {}): BridgeClient {
  const nonce = options.nonce ?? createNonce();
  const helloIntervalMs = options.helloIntervalMs ?? DEFAULT_HELLO_INTERVAL_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  let nextRequestId = 0;
  let ready = false;
  let destroyed = false;
  let readyPromise: Promise<void> | null = null;
  let resolveReady: (() => void) | null = null;

  const pending = new Map<
    number,
    {
      resolve: (res: BridgeSubtitleResult) => void;
      reject: (err: Error) => void;
      cleanup: () => void;
    }
  >();

  const onMessage = (ev: MessageEvent) => {
    const msg = readBridgeMessage(ev, 'to-isolated', nonce);
    if (!msg) return;
    if (msg.type === 'ready') {
      ready = true;
      resolveReady?.();
      return;
    }
    if (msg.type === 'subtitles-result') {
      const entry = pending.get(msg.requestId);
      if (!entry) return;
      pending.delete(msg.requestId);
      entry.cleanup();
      entry.resolve(msg.result);
    }
  };

  window.addEventListener('message', onMessage);
  // 立即发首条 hello 抢占 MAIN world 首次 nonce 绑定窗口
  postBridgeMessage('to-main', nonce, { type: 'hello' });

  const ensureReady = (): Promise<void> => {
    if (ready) return Promise.resolve();
    if (readyPromise) return readyPromise;

    readyPromise = new Promise<void>((resolve, reject) => {
      let intervalId: ReturnType<typeof setInterval> | null = null;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const clearTimers = () => {
        if (intervalId !== null) clearInterval(intervalId);
        if (timeoutId !== null) clearTimeout(timeoutId);
      };

      resolveReady = () => {
        clearTimers();
        resolve();
      };

      postBridgeMessage('to-main', nonce, { type: 'hello' });
      intervalId = setInterval(() => {
        if (ready || destroyed) {
          clearTimers();
          return;
        }
        postBridgeMessage('to-main', nonce, { type: 'hello' });
      }, helloIntervalMs);

      timeoutId = setTimeout(() => {
        clearTimers();
        readyPromise = null;
        resolveReady = null;
        reject(new Error('YouTube MAIN world bridge handshake timed out'));
      }, handshakeTimeoutMs);
    });

    return readyPromise;
  };

  const requestSubtitles = async (
    expectedVideoId: string,
    signal?: AbortSignal,
  ): Promise<BridgeSubtitleResult> => {
    if (destroyed) throw new Error('Bridge client destroyed');
    if (signal?.aborted) throw makeAbortError();

    await ensureReady();
    if (destroyed) throw new Error('Bridge client destroyed');
    if (signal?.aborted) throw makeAbortError();

    const requestId = ++nextRequestId;
    return new Promise<BridgeSubtitleResult>((resolve, reject) => {
      const onAbort = () => {
        pending.delete(requestId);
        cleanup();
        postBridgeMessage('to-main', nonce, { type: 'abort-request', requestId });
        reject(makeAbortError());
      };

      const timer = setTimeout(() => {
        pending.delete(requestId);
        cleanup();
        postBridgeMessage('to-main', nonce, { type: 'abort-request', requestId });
        reject(new Error('YouTube MAIN world bridge request timed out'));
      }, requestTimeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(requestId, { resolve, reject, cleanup });
      postBridgeMessage('to-main', nonce, {
        type: 'get-subtitles',
        requestId,
        expectedVideoId,
      });
    });
  };

  const destroy = () => {
    destroyed = true;
    window.removeEventListener('message', onMessage);
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.cleanup();
      entry.reject(new Error('Bridge client destroyed'));
    }
  };

  return { requestSubtitles, destroy };
}
