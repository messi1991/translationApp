/** 播放器内双语字幕叠加层宿主 id */
export const OVERLAY_HOST_ID = 'translation-app-subtitle-overlay';
/** 控制原平台字幕隐藏的容器属性名 */
export const HIDE_NATIVE_ATTR = 'data-translation-app-hide-native';
/** 注入到 document.head 的原字幕隐藏样式表 id */
export const NATIVE_HIDE_STYLE_ID = 'translation-app-hide-native-style';

const DEFAULT_NATIVE_SELECTORS = ['.ytp-caption-window-container', '.caption-window'];

const OVERLAY_CSS = `
:host {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 60;
  container-type: size;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
}
.sp-wrap {
  position: absolute;
  left: 5%;
  right: 5%;
  bottom: 9%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.sp-box {
  max-width: 88%;
  padding: 6px 14px;
  border-radius: 6px;
  background: rgba(8, 8, 10, 0.76);
  color: #ffffff;
  text-align: center;
  line-height: 1.38;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
  box-sizing: border-box;
}
.sp-box[hidden] {
  display: none;
}
.sp-original {
  margin: 0;
  font-size: clamp(13px, 2.8cqh, 26px);
  color: rgba(255, 255, 255, 0.9);
  white-space: pre-line;
}
.sp-translated {
  margin: 3px 0 0;
  font-size: clamp(14px, 3.3cqh, 30px);
  font-weight: 500;
  color: #ffe58f;
  white-space: pre-line;
}
.sp-notice {
  padding: 5px 12px;
  border-radius: 999px;
  background: rgba(20, 20, 24, 0.82);
  color: rgba(255, 255, 255, 0.92);
  font-size: clamp(12px, 2.4cqh, 18px);
}
`;

export interface RenderableCue {
  original: string;
  translated?: string;
  startMs?: number;
  endMs?: number;
}

export interface SubtitleRendererOptions {
  container: HTMLElement;
  video?: HTMLVideoElement | null;
  hideNativeSubtitles?: boolean;
  nativeSubtitleSelectors?: readonly string[];
}

export interface SubtitleRenderer {
  renderCue: (cue: RenderableCue | null) => void;
  renderNotice: (message: string) => void;
  clearNotice: () => void;
  setHideNativeSubtitles: (hide: boolean) => void;
  destroy: () => void;
}

function ensureNativeHideStyle(selectors: readonly string[]): void {
  if (!document.head) return;
  let styleEl = document.getElementById(NATIVE_HIDE_STYLE_ID) as HTMLStyleElement | null;
  const rule = selectors
    .map((sel) => `[${HIDE_NATIVE_ATTR}="true"] ${sel}`)
    .join(', ');
  const cssText = `${rule} { display: none !important; opacity: 0 !important; pointer-events: none !important; }`;

  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = NATIVE_HIDE_STYLE_ID;
    styleEl.textContent = cssText;
    document.head.appendChild(styleEl);
  } else if (styleEl.textContent !== cssText) {
    styleEl.textContent = cssText;
  }
}

function makeTextTrackCue(startSec: number, endSec: number, text: string): TextTrackCue {
  const VttCtor = (globalThis as unknown as { VTTCue?: typeof VTTCue }).VTTCue;
  if (typeof VttCtor === 'function') {
    return new VttCtor(startSec, endSec, text);
  }
  return { startTime: startSec, endTime: endSec, text } as unknown as TextTrackCue;
}

/**
 * 创建播放器内 Shadow DOM 双语字幕渲染器：
 * - 默认在播放器容器内部叠加（剧院模式与容器全屏零漂移，cqh 自适应字号）
 * - 支持通过容器属性切换隐藏/恢复原字幕
 * - 当 <video> 自身成为 fullscreenElement 时自动降级写入原生 TextTrack
 */
export function createSubtitleRenderer(options: SubtitleRendererOptions): SubtitleRenderer {
  const { container, video = null } = options;
  const selectors = options.nativeSubtitleSelectors ?? DEFAULT_NATIVE_SELECTORS;

  // 若容器无定位上下文，补充 relative 以保证绝对定位叠加在播放器内部
  if (!container.style.position && getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  container.querySelector(`#${OVERLAY_HOST_ID}`)?.remove();
  const host = document.createElement('div');
  host.id = OVERLAY_HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;

  const wrap = document.createElement('div');
  wrap.className = 'sp-wrap';

  const box = document.createElement('div');
  box.className = 'sp-box';
  box.setAttribute('hidden', '');

  wrap.appendChild(box);
  shadow.append(style, wrap);
  container.appendChild(host);

  let lastCue: RenderableCue | null = null;
  let fallbackTrack: TextTrack | null = null;
  let activeTrackCue: TextTrackCue | null = null;

  const clearFallbackTrack = () => {
    if (fallbackTrack && activeTrackCue) {
      try {
        fallbackTrack.removeCue(activeTrackCue);
      } catch {
        /* 忽略已移除的 cue */
      }
    }
    activeTrackCue = null;
    if (fallbackTrack) {
      fallbackTrack.mode = 'disabled';
    }
  };

  const syncVideoFullscreenFallback = () => {
    const isVideoFullscreen = Boolean(video && document.fullscreenElement === video);
    host.style.display = isVideoFullscreen ? 'none' : '';

    if (!isVideoFullscreen || !video) {
      clearFallbackTrack();
      return;
    }

    if (!lastCue) {
      clearFallbackTrack();
      return;
    }

    if (!fallbackTrack && typeof video.addTextTrack === 'function') {
      fallbackTrack = video.addTextTrack('subtitles', 'translationApp', 'zh');
    }
    if (!fallbackTrack) return;

    if (activeTrackCue) {
      try {
        fallbackTrack.removeCue(activeTrackCue);
      } catch {
        /* ignore */
      }
      activeTrackCue = null;
    }

    fallbackTrack.mode = 'showing';
    const startSec = (lastCue.startMs ?? (video.currentTime * 1000)) / 1000;
    const endSec = (lastCue.endMs ?? (startSec * 1000 + 4000)) / 1000;
    const text = lastCue.translated
      ? `${lastCue.original}\n${lastCue.translated}`
      : lastCue.original;
    activeTrackCue = makeTextTrackCue(startSec, Math.max(startSec + 0.2, endSec), text);
    fallbackTrack.addCue(activeTrackCue);
  };

  const setHideNativeSubtitles = (hide: boolean) => {
    if (hide) {
      ensureNativeHideStyle(selectors);
      container.setAttribute(HIDE_NATIVE_ATTR, 'true');
    } else {
      container.removeAttribute(HIDE_NATIVE_ATTR);
    }
  };

  if (options.hideNativeSubtitles) {
    setHideNativeSubtitles(true);
  }

  const clearNotice = () => {
    wrap.querySelector('.sp-notice')?.remove();
  };

  const renderNotice = (message: string) => {
    clearNotice();
    const notice = document.createElement('div');
    notice.className = 'sp-notice';
    notice.textContent = message;
    wrap.appendChild(notice);
  };

  const renderCue = (cue: RenderableCue | null) => {
    lastCue = cue;
    box.replaceChildren();

    if (!cue || !cue.original.trim()) {
      box.setAttribute('hidden', '');
      syncVideoFullscreenFallback();
      return;
    }

    box.removeAttribute('hidden');
    const origEl = document.createElement('p');
    origEl.className = 'sp-original';
    origEl.textContent = cue.original;
    box.appendChild(origEl);

    if (cue.translated && cue.translated.trim()) {
      const transEl = document.createElement('p');
      transEl.className = 'sp-translated';
      transEl.textContent = cue.translated;
      box.appendChild(transEl);
    }

    syncVideoFullscreenFallback();
  };

  const onFullscreenChange = () => {
    syncVideoFullscreenFallback();
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);

  return {
    renderCue,
    renderNotice,
    clearNotice,
    setHideNativeSubtitles,
    destroy() {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      clearFallbackTrack();
      setHideNativeSubtitles(false);
      host.remove();
    },
  };
}
