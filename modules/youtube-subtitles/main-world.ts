import {
  BRIDGE_SOURCE,
  postBridgeMessage,
  readBridgeMessage,
  type BridgeEnvelope,
  type BridgeSubtitleResult,
  type IsolatedToMainMessage,
} from './bridge';
import { buildJson3Url, parseSubtitleBody, requestSubtitleText, type ParsedJson3 } from './json3';
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
  /** 等待播放器发出带 POT 字幕请求的上限毫秒数（默认 5s） */
  sniffWaitMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_POLL_INTERVAL_MS = 150;
const DEFAULT_POLL_TIMEOUT_MS = 8000;

/** InnerTube player 接口（在页面 origin 内请求，带页面会话） */
const INNERTUBE_PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
/** 备用客户端：Android 客户端签发的字幕 URL 不依赖页面 BotGuard 生成的 POT 令牌 */
const FALLBACK_CLIENT_NAME = 'ANDROID';
const FALLBACK_CLIENT_VERSION = '19.09.37';

/** 单次字幕拉取尝试的诊断记录（失败时拼入错误文案，直接出现在页面 console） */
interface TrackAttempt {
  label: string;
  status: number;
  bytes: number;
}

/** 字幕轨道多次尝试均未取到内容 */
class TrackFetchError extends Error {
  readonly attempts: TrackAttempt[];

  constructor(languageCode: string, attempts: TrackAttempt[]) {
    const detail = attempts.map((a) => `${a.label} HTTP ${a.status}（${a.bytes} 字节）`).join(' -> ');
    super(`字幕轨道 ${languageCode} 拉取失败：${detail}`);
    this.name = 'TrackFetchError';
    this.attempts = attempts;
  }
}

/** 页面播放器自己的字幕请求特征：缺 POT 令牌时服务端直接回 200 + 空 body */
const TIMEDTEXT_PATH = '/api/timedtext';
const SNIFF_POLL_INTERVAL_MS = 200;
const SNIFF_WAIT_MS = 5000;

/** 与 POT 同源的会话参数：从播放器成功的请求里补给目标 baseUrl，只补缺 */
const SESSION_PARAM_KEYS = [
  'pot',
  'potc',
  'c',
  'cver',
  'cplayer',
  'cbr',
  'cbrver',
  'cos',
  'cosver',
  'cplatform',
] as const;

interface InterceptedCaption {
  url: string;
  text: string;
}

/** 播放器自己拉到的字幕内容：videoId → 原始响应体 */
const interceptedCaptions = new Map<string, InterceptedCaption>();
/** 播放器自己发出的带 POT 字幕请求 URL：videoId → 最近一条 */
const observedTimedTextUrls = new Map<string, string>();

function toAbsoluteUrl(raw: string): string | null {
  try {
    return new URL(raw, location.href).toString();
  } catch {
    return null;
  }
}

/**
 * 记录播放器自己的字幕响应。
 *
 * WEB 客户端的 baseUrl 缺 POT 令牌，直接 fetch 永远只得 200 + 空 body；
 * 而播放器为了渲染原生字幕一定会带着 POT 请求一次同一批数据，
 * 所以它的 URL（可借 POT 参数）与响应体（可直接解析）都是最可靠的来源。
 */
function rememberTimedTextResponse(rawUrl: string, text: string): void {
  const absolute = toAbsoluteUrl(rawUrl);
  if (!absolute || !absolute.includes(TIMEDTEXT_PATH)) return;

  let url: URL;
  try {
    url = new URL(absolute);
  } catch {
    return;
  }

  const videoId = url.searchParams.get('v');
  if (!videoId) return;
  if (url.searchParams.has('pot')) observedTimedTextUrls.set(videoId, absolute);

  // 自动翻译轨（tlang）不能当源字幕
  if (url.searchParams.has('tlang')) return;
  if (!text.trim()) return;
  if (!interceptedCaptions.has(videoId)) {
    console.info('[translationApp] 已捕获播放器自己的字幕请求，可复用其响应体');
  }
  interceptedCaptions.set(videoId, { url: absolute, text });
}

/** 在 MAIN world 非破坏式横取播放器自己的字幕请求（fetch + XHR） */
export function installTimedTextInterceptor(): void {
  const hookFlag = '__translationAppTimedTextHook';
  type HookFlagged = { [hookFlag]?: boolean };

  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function' && !(rawFetch as unknown as HookFlagged)[hookFlag]) {
    const wrapped = async function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const response = await rawFetch.call(window, input as RequestInfo, init);
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(TIMEDTEXT_PATH)) {
          // clone() 保证不消耗播放器自己的响应体
          void response
            .clone()
            .text()
            .then((text) => rememberTimedTextResponse(url, text))
            .catch(() => {});
        }
      } catch {
        /* 横取失败不影响播放器 */
      }
      return response;
    } as typeof fetch;
    (wrapped as unknown as HookFlagged)[hookFlag] = true;
    window.fetch = wrapped;
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  if (!(originalOpen as unknown as HookFlagged)[hookFlag]) {
    const wrappedOpen = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ): void {
      const rawUrl = String(url);
      if (rawUrl.includes(TIMEDTEXT_PATH)) {
        this.addEventListener(
          'load',
          () => {
            try {
              rememberTimedTextResponse(rawUrl, this.responseText ?? '');
            } catch {
              /* 非文本 responseType 直接跳过 */
            }
          },
          { once: true },
        );
      }
      (originalOpen as unknown as (...args: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof XMLHttpRequest.prototype.open;
    (wrappedOpen as unknown as HookFlagged)[hookFlag] = true;
    XMLHttpRequest.prototype.open = wrappedOpen;
  }
}

/** 读已横取到的字幕体 */
function readInterceptedCaption(videoId: string): InterceptedCaption | null {
  return interceptedCaptions.get(videoId) ?? null;
}

/** 等播放器自己发一次带 POT 的字幕请求（上限 timeoutMs） */
async function waitForPotDonor(
  videoId: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string | null> {
  const immediate = observedTimedTextUrls.get(videoId);
  if (immediate) return immediate;

  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    await waitWithSignal(SNIFF_POLL_INTERVAL_MS, signal);
    const found = observedTimedTextUrls.get(videoId);
    if (found) return found;
  }
  return null;
}

/** 从播放器字幕 URL 的 query 反推轨道信息 */
function describeTimedTextUrl(url: string): { languageCode: string; isAsr: boolean } {
  const params = new URL(url, location.href).searchParams;
  return {
    languageCode: params.get('lang') ?? params.get('tlang') ?? 'unknown',
    isAsr: params.get('kind') === 'asr' || params.get('caps') === 'asr',
  };
}

/**
 * 把播放器请求里的会话参数（含 POT）补进目标 baseUrl。
 * 仅字符串拼接缺失的参数，不重编码原签名参数；已有参数一律不动。
 */
export function graftSessionParams(baseUrl: string, donorUrl: string): string {
  const donor = new URL(donorUrl, location.href).searchParams;
  const existing = new URL(baseUrl, location.href).searchParams;

  const missing = SESSION_PARAM_KEYS.filter(
    (key) => donor.has(key) && !existing.has(key),
  ).map((key) => `${key}=${encodeURIComponent(donor.get(key) ?? '')}`);

  if (missing.length === 0) return baseUrl;
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}${missing.join('&')}`;
}

/** 生成一条轨道的降级候选 URL（借到 POT 后多出 pot-* 两项） */
function candidateUrlsFor(
  track: CaptionTrack,
  videoId: string,
): Array<{ label: string; url: string }> {
  const candidates = [
    { label: 'json3', url: buildJson3Url(track.baseUrl) },
    { label: 'xml', url: track.baseUrl },
  ];

  const donor = observedTimedTextUrls.get(videoId);
  if (donor) {
    const grafted = graftSessionParams(track.baseUrl, donor);
    candidates.push(
      { label: 'pot-json3', url: buildJson3Url(grafted) },
      { label: 'pot-xml', url: grafted },
    );
  }

  return candidates;
}

/** 依次尝试候选 URL，失败记录诊断信息后返回 null */
async function tryLoadCues(
  candidates: ReadonlyArray<{ label: string; url: string }>,
  isAsr: boolean,
  attempts: TrackAttempt[],
  options: { fetchImpl?: typeof fetch; signal: AbortSignal },
): Promise<ParsedJson3 | null> {
  for (const candidate of candidates) {
    const res = await requestSubtitleText(candidate.url, {
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    });
    const parsed = res.ok ? parseSubtitleBody(res.text, { isAsr }) : null;
    if (parsed) return parsed;
    attempts.push({ label: candidate.label, status: res.status, bytes: res.text.length });
  }

  return null;
}

/** 用备用客户端重新请求播放器响应，拿到另一份字幕 baseUrl */
async function fetchFallbackPlayerResponse(
  videoId: string,
  options: { fetchImpl?: typeof fetch; signal: AbortSignal },
): Promise<PlayerResponseLike | null> {
  const fetchFn = options.fetchImpl ?? fetch;
  const response = await fetchFn(INNERTUBE_PLAYER_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-youtube-client-name': '3',
      'x-youtube-client-version': FALLBACK_CLIENT_VERSION,
    },
    credentials: 'include',
    signal: options.signal,
    body: JSON.stringify({
      videoId,
      context: {
        client: {
          clientName: FALLBACK_CLIENT_NAME,
          clientVersion: FALLBACK_CLIENT_VERSION,
          androidSdkVersion: 30,
          hl: 'en',
          gl: 'US',
        },
      },
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });
  if (!response.ok) return null;

  const data = (await response.json()) as PlayerResponseLike | null;
  return data && captionTracksOf(data).length > 0 ? data : null;
}

/** 首选轨道拉不到字幕时，改用备用客户端重新选轨再拉一次 */
async function retryWithFallbackClient(
  videoId: string,
  options: { fetchImpl?: typeof fetch; signal: AbortSignal },
): Promise<ParsedJson3 | null> {
  const resp = await fetchFallbackPlayerResponse(videoId, options).catch((err: unknown) => {
    console.warn('[translationApp] 备用客户端请求播放器响应失败：', err);
    return null;
  });
  if (!resp) {
    console.warn('[translationApp] 备用客户端未返回可用的字幕轨道');
    return null;
  }

  const track = chooseTrack(captionTracksOf(resp), {
    defaultIndex: defaultCaptionIndexOf(resp),
    originalLang: originalAudioLang(resp.streamingData?.adaptiveFormats ?? []),
  });
  if (!track?.baseUrl) return null;

  const parsed = await tryLoadCues(
    candidateUrlsFor(track, videoId),
    isAsrTrack(track),
    [],
    options,
  ).catch((err: unknown) => {
    console.warn('[translationApp] 备用客户端的字幕 URL 依然不可用：', err);
    return null;
  });

  return parsed;
}

interface MoviePlayerElement extends HTMLElement {
  getPlayerResponse?: () => PlayerResponseLike | undefined;
}

function captionTracksOf(resp: PlayerResponseLike): CaptionTrack[] {
  return resp.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
}

function readCurrentPlayerResponse(expectedVideoId: string): PlayerResponseLike | null {
  const player = document.getElementById('movie_player') as MoviePlayerElement | null;
  const fromPlayer = player?.getPlayerResponse?.();

  // 首屏加载早期 #movie_player 可能尚未就绪，但 ytInitialPlayerResponse 已挂在 window 上；
  // 严格比对 videoId 避免 SPA 导航后误读首屏残留对象。
  const initial = (window as unknown as { ytInitialPlayerResponse?: PlayerResponseLike })
    .ytInitialPlayerResponse;

  const candidates = [fromPlayer, initial].filter(
    (resp): resp is PlayerResponseLike => resp?.videoDetails?.videoId === expectedVideoId,
  );
  // 播放器早期响应可能还没有 captionTracks（字幕由后续 player 请求补全），优先取带字幕的那份
  return candidates.find((resp) => captionTracksOf(resp).length > 0) ?? candidates[0] ?? null;
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

/**
 * 等待与 expectedVideoId 匹配的播放器响应：
 * - 拿到带 captionTracks 或已判定为直播的响应即返回
 * - 只拿到无字幕的响应时继续轮询（字幕轨道可能晚几百毫米才就位），直到超时再认定为无字幕
 */
async function waitForMatchingPlayerResponse(
  expectedVideoId: string,
  pollIntervalMs: number,
  pollTimeoutMs: number,
  signal: AbortSignal,
): Promise<PlayerResponseLike | null> {
  const deadline = Date.now() + pollTimeoutMs;
  let lastMatched: PlayerResponseLike | null = null;

  while (!signal.aborted) {
    const resp = readCurrentPlayerResponse(expectedVideoId);
    if (resp) {
      lastMatched = resp;
      if (captionTracksOf(resp).length > 0 || isLiveResponse(resp)) return resp;
    }
    if (Date.now() >= deadline) return lastMatched;
    await waitWithSignal(pollIntervalMs, signal);
  }
  return lastMatched;
}

async function resolveVideoSubtitles(
  expectedVideoId: string,
  options: Required<
    Pick<MainWorldBridgeOptions, 'pollIntervalMs' | 'pollTimeoutMs' | 'sniffWaitMs'>
  > & {
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

  const tracks = captionTracksOf(resp);
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
  const parseOptions = { fetchImpl: options.fetchImpl, signal };
  const attempts: TrackAttempt[] = [];

  // 1) 播放器已经拉过的字幕体（带 POT 的那次），直接解析，无需再发请求
  const intercepted = readInterceptedCaption(expectedVideoId);
  if (intercepted) {
    const track = describeTimedTextUrl(intercepted.url);
    const parsed = parseSubtitleBody(intercepted.text, { isAsr: track.isAsr });
    if (parsed) {
      console.info('[translationApp] 复用播放器已拉取的字幕内容');
      return {
        status: 'ok',
        videoId: expectedVideoId,
        languageCode: track.languageCode,
        isAsr: track.isAsr,
        cues: parsed.cues,
        words: parsed.words,
      };
    }
  }

  // 2) 直拉 baseUrl（json3 / xml），部分环境至今仍可用
  const parsedDirect = await tryLoadCues(
    candidateUrlsFor(picked, expectedVideoId),
    asr,
    attempts,
    parseOptions,
  );
  if (parsedDirect) {
    return {
      status: 'ok',
      videoId: expectedVideoId,
      languageCode: picked.languageCode,
      isAsr: asr,
      cues: parsedDirect.cues,
      words: parsedDirect.words,
    };
  }

  // 3) 等播放器自己发一次带 POT 的请求（开了字幕就会发生）
  const donor = await waitForPotDonor(expectedVideoId, options.sniffWaitMs, signal).catch(
    () => null,
  );
  if (donor) {
    const lateIntercepted = readInterceptedCaption(expectedVideoId);
    if (lateIntercepted) {
      const track = describeTimedTextUrl(lateIntercepted.url);
      const parsed = parseSubtitleBody(lateIntercepted.text, { isAsr: track.isAsr });
      if (parsed) {
        console.info('[translationApp] 复用播放器已拉取的字幕内容');
        return {
          status: 'ok',
          videoId: expectedVideoId,
          languageCode: track.languageCode,
          isAsr: track.isAsr,
          cues: parsed.cues,
          words: parsed.words,
        };
      }
    }

    // 借它的会话参数（pot 等）重拉目标轨道
    const grafted = await tryLoadCues(
      candidateUrlsFor(picked, expectedVideoId).filter((c) => c.label.startsWith('pot-')),
      asr,
      attempts,
      parseOptions,
    );
    if (grafted) {
      console.info('[translationApp] 借用播放器 POT 参数拉取字幕成功');
      return {
        status: 'ok',
        videoId: expectedVideoId,
        languageCode: picked.languageCode,
        isAsr: asr,
        cues: grafted.cues,
        words: grafted.words,
      };
    }
  }

  // 4) 换一份签名 URL（备用客户端）再走一遍
  const retried = await retryWithFallbackClient(expectedVideoId, parseOptions);
  if (retried) {
    return {
      status: 'ok',
      videoId: expectedVideoId,
      languageCode: picked.languageCode,
      isAsr: asr,
      cues: retried.cues,
      words: retried.words,
    };
  }

  throw new TrackFetchError(picked.languageCode, attempts);
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
  // document_start 即可开始横取播放器自己的字幕请求（含 POT），避免错过首次拉取
  installTimedTextInterceptor();

  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const sniffWaitMs = options.sniffWaitMs ?? SNIFF_WAIT_MS;

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
        { pollIntervalMs, pollTimeoutMs, sniffWaitMs, fetchImpl: options.fetchImpl },
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
