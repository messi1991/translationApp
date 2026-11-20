import type { PipelineCue } from './regroup';

export type ClockTickReason = 'init' | 'frame' | 'seek' | 'pause' | 'play' | 'ratechange';

const OVERLAP_LOOKBACK = 4;

/**
 * 二分查找当前时间点 timeMs（毫秒）应展示的 cue 下标。
 * 找到 startMs <= timeMs 的最后一条后，最多回溯 4 条检查是否仍在有效期内（endMs > timeMs），
 * 以兼容重叠字幕（例如背景长句中插入短促语气词结束后的回落）。
 */
export function cueAt(cues: readonly PipelineCue[], timeMs: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let idx = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (cues[mid]!.startMs <= timeMs) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  for (let i = idx; i >= 0 && i >= idx - OVERLAP_LOOKBACK; i -= 1) {
    if (timeMs < cues[i]!.endMs) {
      return i;
    }
  }
  return -1;
}

/**
 * 启动视频时间同步时钟：
 * - 优先使用 HTMLVideoElement.requestVideoFrameCallback 的 mediaTime 精确跟帧（变速不漂移）
 * - 浏览器不支持时回退 requestAnimationFrame
 * - 监听 seeked / pause / play / ratechange 即时同步，暂停时不空转且保持当前字幕显示
 */
export function startVideoClock(
  video: HTMLVideoElement,
  onTick: (timeMs: number, reason: ClockTickReason) => void,
): () => void {
  const hasRvfc = typeof video.requestVideoFrameCallback === 'function';

  let frameHandle = 0;
  let stopped = false;

  const cancelPendingFrame = () => {
    if (!frameHandle) return;
    const id = frameHandle;
    frameHandle = 0;
    if (hasRvfc && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(id);
    } else {
      window.cancelAnimationFrame(id);
    }
  };

  const scheduleNextFrame = () => {
    if (stopped || frameHandle !== 0 || video.paused) return;

    if (hasRvfc) {
      frameHandle = video.requestVideoFrameCallback((_now, meta) => {
        frameHandle = 0;
        if (stopped) return;
        onTick(meta.mediaTime * 1000, 'frame');
        if (!video.paused) {
          scheduleNextFrame();
        }
      });
    } else {
      frameHandle = window.requestAnimationFrame(() => {
        frameHandle = 0;
        if (stopped) return;
        onTick(video.currentTime * 1000, 'frame');
        if (!video.paused) {
          scheduleNextFrame();
        }
      });
    }
  };

  const onSeeked = () => {
    if (stopped) return;
    onTick(video.currentTime * 1000, 'seek');
    scheduleNextFrame();
  };

  const onPause = () => {
    if (stopped) return;
    onTick(video.currentTime * 1000, 'pause');
  };

  const onPlay = () => {
    if (stopped) return;
    onTick(video.currentTime * 1000, 'play');
    scheduleNextFrame();
  };

  const onRateChange = () => {
    if (stopped) return;
    onTick(video.currentTime * 1000, 'ratechange');
    scheduleNextFrame();
  };

  video.addEventListener('seeked', onSeeked);
  video.addEventListener('pause', onPause);
  video.addEventListener('play', onPlay);
  video.addEventListener('ratechange', onRateChange);

  // 初始化立即投递当前时间（即使视频处于暂停状态也能立刻渲染当前帧字幕）
  onTick(video.currentTime * 1000, 'init');
  scheduleNextFrame();

  return () => {
    stopped = true;
    cancelPendingFrame();
    video.removeEventListener('seeked', onSeeked);
    video.removeEventListener('pause', onPause);
    video.removeEventListener('play', onPlay);
    video.removeEventListener('ratechange', onRateChange);
  };
}
