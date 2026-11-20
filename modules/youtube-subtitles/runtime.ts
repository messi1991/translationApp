import { watchSettings } from '@/modules/settings';
import {
  createSubtitleRenderer,
  startSubtitlePipeline,
  type BatchTranslateFn,
  type SubtitlePipelineSession,
  type SubtitleRenderer,
} from '@/modules/subtitle-pipeline';
import type { BridgeClient } from './bridge';
import { startYouTubeSubtitleSource, type YouTubeSubtitleState } from './index';

const PLAYER_SELECTORS = ['#movie_player', '#shorts-player', 'ytd-player', '#player-container'];
const YOUTUBE_NATIVE_CAPTION_SELECTORS = ['.ytp-caption-window-container', '.caption-window'];
const DOM_WAIT_INTERVAL_MS = 120;
const DOM_WAIT_TIMEOUT_MS = 6000;
const NOTICE_AUTO_HIDE_MS = 4500;

export interface StartYouTubeSubtitlesOptions {
  getUrl?: () => string;
  pollIntervalMs?: number;
  bridge?: BridgeClient;
  translateBatch?: BatchTranslateFn;
  noticeDurationMs?: number;
}

export interface YouTubeSubtitlesHandle {
  destroy: () => void;
}

function findPlayerContainer(): HTMLElement | null {
  for (const selector of PLAYER_SELECTORS) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) return el;
  }
  return null;
}

function findPlayerAndVideo(): { container: HTMLElement; video: HTMLVideoElement } | null {
  const container = document.getElementById('movie_player') ?? findPlayerContainer();
  if (!container) return null;
  const video =
    container.querySelector<HTMLVideoElement>('video.html5-main-video') ??
    container.querySelector<HTMLVideoElement>('video') ??
    document.querySelector<HTMLVideoElement>('video');
  if (!video) return null;
  return { container, video };
}

async function waitForDom<T>(
  probe: () => T | null,
  isCancelled: () => boolean,
): Promise<T | null> {
  const immediate = probe();
  if (immediate) return immediate;

  const deadline = Date.now() + DOM_WAIT_TIMEOUT_MS;
  while (!isCancelled() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DOM_WAIT_INTERVAL_MS));
    const found = probe();
    if (found) return found;
  }
  return null;
}

function unsupportedNoticeText(reason: 'live' | 'shorts'): string {
  return reason === 'live'
    ? '当前视频为直播/预告，暂不支持双语字幕'
    : 'YouTube Shorts 暂不支持双语字幕';
}

/**
 * 组装 YouTube 双语字幕完整运行链路（isolated world）：
 * 页面检测 → 开关与黑名单门控 → MAIN 桥拉取 json3 → subtitle-pipeline 重组/预翻译/帧同步渲染；
 * 监听 settings 变化使开关/语言/引擎调整立即生效，直播与 Shorts 展示轻量提示条，异常静默降级恢复原字幕。
 */
export function startYouTubeSubtitles(
  options: StartYouTubeSubtitlesOptions = {},
): YouTubeSubtitlesHandle {
  const noticeDurationMs = options.noticeDurationMs ?? NOTICE_AUTO_HIDE_MS;

  let destroyed = false;
  let stateSeq = 0;
  let activePipeline: SubtitlePipelineSession | null = null;
  let noticeRenderer: SubtitleRenderer | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  const teardownActive = () => {
    if (noticeTimer !== null) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    noticeRenderer?.destroy();
    noticeRenderer = null;
    activePipeline?.destroy();
    activePipeline = null;
  };

  const mountUnsupportedNotice = async (reason: 'live' | 'shorts', seq: number) => {
    const isCancelled = () => destroyed || seq !== stateSeq;
    const container = await waitForDom(findPlayerContainer, isCancelled);
    if (!container || isCancelled()) return;

    noticeRenderer = createSubtitleRenderer({
      container,
      hideNativeSubtitles: false,
    });
    noticeRenderer.renderNotice(unsupportedNoticeText(reason));

    if (noticeDurationMs > 0) {
      noticeTimer = setTimeout(() => {
        noticeRenderer?.clearNotice();
      }, noticeDurationMs);
    }
  };

  const mountPipeline = async (
    state: Extract<YouTubeSubtitleState, { kind: 'ready' }>,
    seq: number,
  ) => {
    const isCancelled = () => destroyed || seq !== stateSeq;
    const elements = await waitForDom(findPlayerAndVideo, isCancelled);
    if (!elements || isCancelled()) return;

    activePipeline = startSubtitlePipeline({
      container: elements.container,
      video: elements.video,
      cues: state.cues,
      words: state.words,
      isAsr: state.isAsr,
      from: state.languageCode,
      hideNativeSubtitles: true,
      nativeSubtitleSelectors: YOUTUBE_NATIVE_CAPTION_SELECTORS,
      translateBatch: options.translateBatch,
    });
  };

  const onStateChange = (state: YouTubeSubtitleState) => {
    const seq = ++stateSeq;
    teardownActive();

    if (state.kind === 'ready') {
      void mountPipeline(state, seq).catch(() => {
        // 渲染或挂载异常静默降级，确保原字幕恢复
        if (seq === stateSeq) teardownActive();
      });
      return;
    }

    if (state.kind === 'unsupported' && (state.reason === 'live' || state.reason === 'shorts')) {
      void mountUnsupportedNotice(state.reason, seq).catch(() => {
        if (seq === stateSeq) teardownActive();
      });
    }
    // idle / loading / unsupported(no-captions) / error 均保持原字幕原样显示（静默降级）
  };

  const source = startYouTubeSubtitleSource({
    onStateChange,
    getUrl: options.getUrl,
    pollIntervalMs: options.pollIntervalMs,
    bridge: options.bridge,
  });

  // 开关、黑名单、目标语言或引擎在设置页/弹窗变更时立即重新评估与刷新
  const unwatch = watchSettings(() => {
    if (!destroyed) {
      source.refresh();
    }
  });

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stateSeq += 1;
      unwatch();
      source.destroy();
      teardownActive();
    },
  };
}
