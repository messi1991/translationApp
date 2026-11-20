import { cueAt, startVideoClock } from './clock';
import {
  normalizeManualCues,
  regroupAsrWords,
  type PipelineCue,
  type PipelineWord,
} from './regroup';
import { createSubtitleRenderer } from './renderer';
import { createSubtitleScheduler, type BatchTranslateFn } from './scheduler';

export interface StartSubtitlePipelineOptions {
  container: HTMLElement;
  video: HTMLVideoElement;
  cues: readonly PipelineCue[];
  words?: readonly PipelineWord[];
  isAsr: boolean;
  from?: string;
  to?: string;
  hideNativeSubtitles?: boolean;
  nativeSubtitleSelectors?: readonly string[];
  translateBatch?: BatchTranslateFn;
  onError?: (message: string) => void;
}

export interface SubtitlePipelineSession {
  cues: readonly PipelineCue[];
  setHideNativeSubtitles: (hide: boolean) => void;
  destroy: () => void;
}

/** 翻译错误提示条自动隐藏毫秒数 */
const NOTICE_HIDE_MS = 6000;

/**
 * 启动平台无关双语字幕流水线会话：
 * 1. ASR 词序列重组为可读 cue（无词级数据时回退对 cues 归一化），手动字幕做去重与重叠裁剪
 * 2. 创建位置感知预翻译调度器（lookbehind 3s / horizon 6min / 60 条每批）
 * 3. 启动 requestVideoFrameCallback 视频时钟，二分查找当前 cue 并驱动 Shadow DOM 叠加渲染
 * 4. 翻译失败时在叠加层展示提示条（同一条错误不重复刷屏），否则用户只能看到原文而不知原因
 */
export function startSubtitlePipeline(
  options: StartSubtitlePipelineOptions,
): SubtitlePipelineSession {
  const preparedCues =
    options.isAsr && options.words && options.words.length > 0
      ? regroupAsrWords(options.words)
      : normalizeManualCues(options.cues);

  const renderer = createSubtitleRenderer({
    container: options.container,
    video: options.video,
    hideNativeSubtitles: options.hideNativeSubtitles ?? true,
    nativeSubtitleSelectors: options.nativeSubtitleSelectors,
  });

  let activeCueIndex = -1;
  let lastRenderedTranslated: string | undefined;

  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let activeNotice: string | null = null;

  // 同一条错误正在展示时不重复覆盖，避免每批重试都把提示条重刷一次
  const showNotice = (message: string) => {
    if (activeNotice === message) return;
    activeNotice = message;
    renderer.renderNotice(message);
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      activeNotice = null;
      renderer.clearNotice();
    }, NOTICE_HIDE_MS);
  };

  const syncCueDisplay = (cueIdx: number) => {
    const cue = cueIdx >= 0 ? preparedCues[cueIdx] : undefined;
    if (!cue) {
      if (activeCueIndex !== -1) {
        activeCueIndex = -1;
        lastRenderedTranslated = undefined;
        renderer.renderCue(null);
      }
      return;
    }

    const translated = scheduler.getTranslation(cueIdx);
    if (cueIdx === activeCueIndex && translated === lastRenderedTranslated) {
      return;
    }
    activeCueIndex = cueIdx;
    lastRenderedTranslated = translated;
    renderer.renderCue({
      original: cue.text,
      translated,
      startMs: cue.startMs,
      endMs: cue.endMs,
    });
  };

  const scheduler = createSubtitleScheduler({
    cues: preparedCues,
    from: options.from,
    to: options.to,
    translateBatch: options.translateBatch,
    onError: (message) => {
      options.onError?.(message);
      showNotice(message);
    },
    onUpdate: (indices) => {
      if (activeCueIndex >= 0 && indices.includes(activeCueIndex)) {
        syncCueDisplay(activeCueIndex);
      }
    },
  });

  const stopClock = startVideoClock(options.video, (timeMs, reason) => {
    if (reason === 'seek') {
      scheduler.seek(timeMs);
    } else {
      scheduler.updateTime(timeMs);
    }
    syncCueDisplay(cueAt(preparedCues, timeMs));
  });

  return {
    cues: preparedCues,
    setHideNativeSubtitles(hide: boolean) {
      renderer.setHideNativeSubtitles(hide);
    },
    destroy() {
      stopClock();
      if (noticeTimer !== null) {
        clearTimeout(noticeTimer);
        noticeTimer = null;
      }
      scheduler.destroy();
      renderer.destroy();
    },
  };
}

export {
  displayWidth,
  normalizeManualCues,
  regroupAsrWords,
  type PipelineCue,
  type PipelineWord,
} from './regroup';
export {
  buildCueContexts,
  createSubtitleScheduler,
  DEFAULT_MAX_CONCURRENCY,
  FAILED_RETRY_COOLDOWN_MS,
  MAX_CONTEXT_CHARS,
  MAX_RETRY_ATTEMPTS,
  planNextBatch,
  SCHEDULE_HORIZON_MS,
  SCHEDULE_LOOKBEHIND_MS,
  SCHEDULE_MAX_BATCH_CHARS,
  SCHEDULE_MAX_BATCH_SIZE,
  type BatchTranslateFn,
  type BatchTranslateResponse,
  type CueWithContext,
  type SubtitleScheduler,
  type SubtitleSchedulerOptions,
} from './scheduler';
export { cueAt, startVideoClock, type ClockTickReason } from './clock';
export {
  createSubtitleRenderer,
  HIDE_NATIVE_ATTR,
  NATIVE_HIDE_STYLE_ID,
  OVERLAY_HOST_ID,
  type RenderableCue,
  type SubtitleRenderer,
  type SubtitleRendererOptions,
} from './renderer';
