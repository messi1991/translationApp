import { getSettings, isHostBlocked } from '@/modules/settings';
import {
  createIsolatedBridgeClient,
  type BridgeClient,
  type BridgeSubtitleResult,
} from './bridge';
import type { SubtitleCue, SubtitleWord } from './json3';
import { classifyYouTubeUrl, observeYouTubeNavigation } from './navigation';

export type YouTubeSubtitleState =
  | { kind: 'idle' }
  | { kind: 'loading'; videoId: string }
  | {
      kind: 'ready';
      videoId: string;
      languageCode: string;
      isAsr: boolean;
      cues: SubtitleCue[];
      words: SubtitleWord[];
    }
  | { kind: 'unsupported'; reason: 'live' | 'shorts' | 'no-captions'; videoId?: string }
  | { kind: 'error'; message: string; videoId?: string };

export interface StartYouTubeSubtitleSourceOptions {
  onStateChange: (state: YouTubeSubtitleState) => void;
  getUrl?: () => string;
  pollIntervalMs?: number;
  bridge?: BridgeClient;
}

export interface YouTubeSubtitleSourceHandle {
  refresh: () => void;
  destroy: () => void;
}

/** 判定当前 URL 是否应启用 YouTube 字幕功能（配置开关 + 站点黑名单 + 协议） */
export async function shouldActivateYouTubeSubtitles(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  try {
    const settings = await getSettings();
    if (!settings.features.youtubeSubtitles) return false;
    return !isHostBlocked(parsed.hostname, settings.blockedHosts);
  } catch {
    return false;
  }
}

function mapBridgeResultToState(
  expectedVideoId: string,
  res: BridgeSubtitleResult,
): YouTubeSubtitleState {
  if ('videoId' in res && res.videoId && res.videoId !== expectedVideoId) {
    return {
      kind: 'error',
      videoId: expectedVideoId,
      message: 'Stale videoId returned from MAIN world bridge',
    };
  }
  switch (res.status) {
    case 'ok':
      return {
        kind: 'ready',
        videoId: res.videoId,
        languageCode: res.languageCode,
        isAsr: res.isAsr,
        cues: res.cues,
        words: res.words,
      };
    case 'live':
      return { kind: 'unsupported', reason: 'live', videoId: res.videoId };
    case 'no-captions':
      return { kind: 'unsupported', reason: 'no-captions', videoId: res.videoId };
    case 'error':
      return { kind: 'error', message: res.message, videoId: res.videoId };
  }
}

/**
 * 启动 isolated world 侧 YouTube 字幕源控制器：
 * - 跟随 SPA 路由变化自动重新获取字幕
 * - 维护单调递增 sessionSeq + AbortController，彻底杜绝快速切视频串台
 */
export function startYouTubeSubtitleSource(
  options: StartYouTubeSubtitleSourceOptions,
): YouTubeSubtitleSourceHandle {
  const getUrl = options.getUrl ?? (() => location.href);
  const ownsBridge = !options.bridge;
  const bridge = options.bridge ?? createIsolatedBridgeClient();

  let destroyed = false;
  let sessionSeq = 0;
  let currentAbort: AbortController | null = null;

  const emit = (state: YouTubeSubtitleState) => {
    if (!destroyed) options.onStateChange(state);
  };

  const handleUrl = async (url: string) => {
    const seq = ++sessionSeq;
    currentAbort?.abort();
    currentAbort = null;

    const active = await shouldActivateYouTubeSubtitles(url);
    if (destroyed || seq !== sessionSeq) return;
    if (!active) {
      emit({ kind: 'idle' });
      return;
    }

    const route = classifyYouTubeUrl(url);
    if (route.kind === 'other') {
      emit({ kind: 'idle' });
      return;
    }
    if (route.kind === 'shorts') {
      emit({ kind: 'unsupported', reason: 'shorts', videoId: route.videoId });
      return;
    }

    const ac = new AbortController();
    currentAbort = ac;
    emit({ kind: 'loading', videoId: route.videoId });

    try {
      const result = await bridge.requestSubtitles(route.videoId, ac.signal);
      if (destroyed || seq !== sessionSeq || ac.signal.aborted) return;
      emit(mapBridgeResultToState(route.videoId, result));
    } catch (err) {
      if (destroyed || seq !== sessionSeq || ac.signal.aborted) return;
      emit({
        kind: 'error',
        videoId: route.videoId,
        message: err instanceof Error ? err.message : 'Failed to fetch YouTube subtitles',
      });
    }
  };

  const stopNav = observeYouTubeNavigation(
    (nextUrl) => {
      void handleUrl(nextUrl);
    },
    { getUrl, pollIntervalMs: options.pollIntervalMs },
  );

  void handleUrl(getUrl());

  return {
    refresh: () => {
      if (!destroyed) void handleUrl(getUrl());
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      sessionSeq += 1;
      currentAbort?.abort();
      currentAbort = null;
      stopNav();
      if (ownsBridge) bridge.destroy();
    },
  };
}

export {
  chooseTrack,
  isAsrTrack,
  normalizeLangTag,
  originalAudioLang,
  type AudioFormat,
  type CaptionTrack,
  type ChooseTrackOptions,
} from './track';
export {
  buildJson3Url,
  fetchJson3Track,
  parseJson3,
  type FetchJson3Options,
  type Json3Event,
  type Json3Payload,
  type Json3Segment,
  type ParsedJson3,
  type SubtitleCue,
  type SubtitleWord,
} from './json3';
export {
  BRIDGE_SOURCE,
  createIsolatedBridgeClient,
  createNonce,
  postBridgeMessage,
  readBridgeMessage,
  type BridgeClient,
  type BridgeClientOptions,
  type BridgeDirection,
  type BridgeEnvelope,
  type BridgeSubtitleResult,
  type IsolatedToMainMessage,
  type MainToIsolatedMessage,
} from './bridge';
export {
  startMainWorldBridge,
  type MainWorldBridgeOptions,
  type PlayerResponseLike,
} from './main-world';
export {
  classifyYouTubeUrl,
  observeYouTubeNavigation,
  type ObserveNavigationOptions,
  type YouTubeRoute,
} from './navigation';
export {
  startYouTubeSubtitles,
  type StartYouTubeSubtitlesOptions,
  type YouTubeSubtitlesHandle,
} from './runtime';
