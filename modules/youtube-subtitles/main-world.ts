import {
  BRIDGE_SOURCE,
  postBridgeMessage,
  readBridgeMessage,
  type BridgeEnvelope,
  type BridgeSubtitleResult,
  type IsolatedToMainMessage,
} from './bridge';
import { fetchJson3Track } from './json3';
import {
  chooseTrack,
  isAsrTrack,
  originalAudioLang,
  type AudioFormat,
  type CaptionTrack,
} from './track';

/** YouTube playerResponse 最小契约子集 */
export interface PlayerResponseLike {
  videoDetails?: {
    videoId?: string;
    isLiveContent?: boolean;
    isUpcoming?: boolean;
  };
  microformat?: {
    playerMicroformatRenderer?: {
      liveBroadcastDetails?: { isLiveNow?: boolean };
    };
  };
  streamingData?: {
    adaptiveFormats?: AudioFormat[];
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
      audioTracks?: Array<{ defaultCaptionTrackIndex?: number }>;
      defaultAudioTrackIndex?: number;
    };
  };
}

export interface MainWorldBridgeOptions {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_POLL_INTERVAL_MS = 150;
const DEFAULT_POLL_TIMEOUT_MS = 8000;

interface MoviePlayerElement extends HTMLElement {
  getPlayerResponse?: () => PlayerResponseLike | undefined;
}

function readCurrentPlayerResponse(expectedVideoId: string): PlayerResponseLike | null {
  const player = document.getElementById('movie_player') as MoviePlayerElement | null;
  const fromPlayer = player?.getPlayerResponse?.();
  if (fromPlayer?.videoDetails?.videoId === expectedVideoId) {
    return fromPlayer;
  }

  // 首屏加载早期 #movie_player 可能尚未就绪，但 ytInitialPlayerResponse 已挂在 window 上；
  // 严格比对 videoId 避免 SPA 导航后误读首屏残留对象。
  const initial = (window as unknown as { ytInitialPlayerResponse?: PlayerResponseLike })
    .ytInitialPlayerResponse;
  if (initial?.videoDetails?.videoId === expectedVideoId) {
    return initial;
  }
  return null;
}

function isLiveResponse(resp: PlayerResponseLike): boolean {
  if (resp.videoDetails?.isLiveContent) return true;
  if (resp.videoDetails?.isUpcoming) return true;
  if (resp.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow) return true;
  return false;
}

function defaultCaptionIndexOf(resp: PlayerResponseLike): number | undefined {
  const renderer = resp.captions?.playerCaptionsTracklistRenderer;
  if (!renderer?.audioTracks?.length) return undefined;
  const audioIdx = renderer.defaultAudioTrackIndex ?? 0;
  return renderer.audioTracks[audioIdx]?.defaultCaptionTrackIndex;
}

function waitWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForMatchingPlayerResponse(
  expectedVideoId: string,
  pollIntervalMs: number,
  pollTimeoutMs: number,
  signal: AbortSignal,
): Promise<PlayerResponseLike | null> {
  const deadline = Date.now() + pollTimeoutMs;
  while (!signal.aborted) {
    const resp = readCurrentPlayerResponse(expectedVideoId);
    if (resp) return resp;
    if (Date.now() >= deadline) return null;
    await waitWithSignal(pollIntervalMs, signal);
  }
  return null;
}

async function resolveVideoSubtitles(
  expectedVideoId: string,
  options: Required<Pick<MainWorldBridgeOptions, 'pollIntervalMs' | 'pollTimeoutMs'>> & {
    fetchImpl?: typeof fetch;
  },
  signal: AbortSignal,
): Promise<BridgeSubtitleResult> {
  const resp = await waitForMatchingPlayerResponse(
    expectedVideoId,
    options.pollIntervalMs,
    options.pollTimeoutMs,
    signal,
  );
  if (!resp) {
    return {
      status: 'error',
      videoId: expectedVideoId,
      message: 'Player response for expected videoId not ready before timeout',
    };
  }

  if (isLiveResponse(resp)) {
    return { status: 'live', videoId: expectedVideoId };
  }

  const tracks = resp.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (tracks.length === 0) {
    return { status: 'no-captions', videoId: expectedVideoId };
  }

  const formats = resp.streamingData?.adaptiveFormats ?? [];
  const picked = chooseTrack(tracks, {
    defaultIndex: defaultCaptionIndexOf(resp),
    originalLang: originalAudioLang(formats),
  });
  if (!picked?.baseUrl) {
    return { status: 'no-captions', videoId: expectedVideoId };
  }

  const asr = isAsrTrack(picked);
  const parsed = await fetchJson3Track(picked.baseUrl, {
    isAsr: asr,
    signal,
    fetchImpl: options.fetchImpl,
  });

  return {
    status: 'ok',
    videoId: expectedVideoId,
    languageCode: picked.languageCode,
    isAsr: asr,
    cues: parsed.cues,
    words: parsed.words,
  };
}

function extractInitialHelloNonce(ev: MessageEvent): string | null {
  if (ev.source !== window && !(ev.source === null && /jsdom/i.test(navigator.userAgent))) {
    return null;
  }
  const data = ev.data as Partial<BridgeEnvelope<IsolatedToMainMessage>> | null;
  if (!data || typeof data !== 'object') return null;
  if (data.source !== BRIDGE_SOURCE || data.dir !== 'to-main') return null;
  if (typeof data.nonce !== 'string' || data.nonce.length === 0) return null;
  if (data.msg?.type !== 'hello') return null;
  return data.nonce;
}

/**
 * 启动 MAIN world 桥服务端：
 * - 接收首条合法 hello 消息并锁定本页会话 nonce（后续一切不匹配 nonce 的消息均忽略）
 * - 响应 get-subtitles：等待播放器切换到 expectedVideoId，选轨并拉取 json3 字幕回传
 */
export function startMainWorldBridge(options: MainWorldBridgeOptions = {}): () => void {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;

  let boundNonce: string | null = null;
  const inflight = new Map<number, AbortController>();

  const onMessage = (ev: MessageEvent) => {
    if (boundNonce === null) {
      const candidate = extractInitialHelloNonce(ev);
      if (!candidate) return;
      boundNonce = candidate;
      postBridgeMessage('to-isolated', boundNonce, { type: 'ready' });
      return;
    }

    const msg = readBridgeMessage(ev, 'to-main', boundNonce);
    if (!msg) return;

    if (msg.type === 'hello') {
      postBridgeMessage('to-isolated', boundNonce, { type: 'ready' });
      return;
    }

    if (msg.type === 'abort-request') {
      const ac = inflight.get(msg.requestId);
      if (ac) {
        inflight.delete(msg.requestId);
        ac.abort();
      }
      return;
    }

    if (msg.type === 'get-subtitles') {
      const nonce = boundNonce;
      const ac = new AbortController();
      inflight.set(msg.requestId, ac);

      void resolveVideoSubtitles(
        msg.expectedVideoId,
        { pollIntervalMs, pollTimeoutMs, fetchImpl: options.fetchImpl },
        ac.signal,
      )
        .then(
          (result) => result,
          (err: unknown): BridgeSubtitleResult => ({
            status: 'error',
            videoId: msg.expectedVideoId,
            message: err instanceof Error ? err.message : 'Unknown error',
          }),
        )
        .then((result) => {
          inflight.delete(msg.requestId);
          if (ac.signal.aborted) return;
          postBridgeMessage('to-isolated', nonce, {
            type: 'subtitles-result',
            requestId: msg.requestId,
            result,
          });
        });
    }
  };

  window.addEventListener('message', onMessage);

  return () => {
    window.removeEventListener('message', onMessage);
    for (const [, ac] of inflight) {
      ac.abort();
    }
    inflight.clear();
  };
}
