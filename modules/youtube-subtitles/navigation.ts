export type YouTubeRoute =
  | { kind: 'watch'; videoId: string }
  | { kind: 'shorts'; videoId: string }
  | { kind: 'other' };

export interface ObserveNavigationOptions {
  getUrl?: () => string;
  pollIntervalMs?: number;
}

const DEFAULT_NAV_POLL_MS = 1000;
const NAVIGATION_EVENTS = ['yt-navigate-finish', 'yt-page-data-updated', 'popstate'] as const;

function isYouTubeHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'youtube.com' || lower.endsWith('.youtube.com');
}

/** 解析 YouTube URL 类型（普通观看页 / Shorts / 其他） */
export function classifyYouTubeUrl(url: string): YouTubeRoute {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'other' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'other' };
  }
  if (!isYouTubeHost(parsed.hostname)) {
    return { kind: 'other' };
  }

  const path = parsed.pathname;
  if (path === '/watch') {
    const v = parsed.searchParams.get('v')?.trim();
    return v ? { kind: 'watch', videoId: v } : { kind: 'other' };
  }

  const embedMatch = /^\/embed\/([^/?#]+)/.exec(path);
  if (embedMatch?.[1]) {
    return { kind: 'watch', videoId: embedMatch[1] };
  }

  const shortsMatch = /^\/shorts\/([^/?#]+)/.exec(path);
  if (shortsMatch?.[1]) {
    return { kind: 'shorts', videoId: shortsMatch[1] };
  }

  return { kind: 'other' };
}

/**
 * 监听 YouTube SPA 路由变化：
 * 同时订阅 yt-navigate-finish / yt-page-data-updated / popstate，
 * 并辅以 1s URL 轮询兜底（m.youtube.com 或嵌入页不派发 yt-* 自定义事件）。
 */
export function observeYouTubeNavigation(
  onUrlChange: (url: string) => void,
  options: ObserveNavigationOptions = {},
): () => void {
  const getUrl = options.getUrl ?? (() => location.href);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_NAV_POLL_MS;
  let lastUrl = getUrl();

  const check = () => {
    const next = getUrl();
    if (next === lastUrl) return;
    lastUrl = next;
    onUrlChange(next);
  };

  for (const eventName of NAVIGATION_EVENTS) {
    window.addEventListener(eventName, check);
  }
  const timer = setInterval(check, pollIntervalMs);

  return () => {
    clearInterval(timer);
    for (const eventName of NAVIGATION_EVENTS) {
      window.removeEventListener(eventName, check);
    }
  };
}
