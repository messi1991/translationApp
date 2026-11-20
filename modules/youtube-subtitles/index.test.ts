import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_SETTINGS, saveSettings } from '@/modules/settings';
import { startMainWorldBridge, type PlayerResponseLike } from './main-world';
import {
  classifyYouTubeUrl,
  observeYouTubeNavigation,
  shouldActivateYouTubeSubtitles,
  startYouTubeSubtitleSource,
  type YouTubeSubtitleState,
} from './index';

describe('classifyYouTubeUrl', () => {
  it('识别普通观看页 /watch?v=xxx 与嵌入页 /embed/xxx', () => {
    expect(classifyYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      kind: 'watch',
      videoId: 'dQw4w9WgXcQ',
    });
    expect(classifyYouTubeUrl('https://m.youtube.com/watch?v=abc_123&t=10s')).toEqual({
      kind: 'watch',
      videoId: 'abc_123',
    });
    expect(classifyYouTubeUrl('https://www.youtube.com/embed/xyz789?autoplay=1')).toEqual({
      kind: 'watch',
      videoId: 'xyz789',
    });
  });

  it('识别 Shorts 页面 /shorts/xxx', () => {
    expect(classifyYouTubeUrl('https://www.youtube.com/shorts/short_01')).toEqual({
      kind: 'shorts',
      videoId: 'short_01',
    });
  });

  it('识别首页、搜索页或非 YouTube 域名为 other', () => {
    expect(classifyYouTubeUrl('https://www.youtube.com/')).toEqual({ kind: 'other' });
    expect(classifyYouTubeUrl('https://www.youtube.com/results?search_query=wxt')).toEqual({
      kind: 'other',
    });
    expect(classifyYouTubeUrl('https://example.com/watch?v=123')).toEqual({ kind: 'other' });
  });
});

describe('shouldActivateYouTubeSubtitles', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('开关开启且未命中黑名单时返回 true', async () => {
    await saveSettings(DEFAULT_SETTINGS);
    expect(await shouldActivateYouTubeSubtitles('https://www.youtube.com/watch?v=1')).toBe(true);
  });

  it('youtubeSubtitles 开关关闭或 youtube.com 在黑名单中时返回 false', async () => {
    await saveSettings({
      ...DEFAULT_SETTINGS,
      features: { ...DEFAULT_SETTINGS.features, youtubeSubtitles: false },
    });
    expect(await shouldActivateYouTubeSubtitles('https://www.youtube.com/watch?v=1')).toBe(false);

    await saveSettings({
      ...DEFAULT_SETTINGS,
      blockedHosts: ['youtube.com'],
    });
    expect(await shouldActivateYouTubeSubtitles('https://www.youtube.com/watch?v=1')).toBe(false);
  });
});

describe('observeYouTubeNavigation', () => {
  it('响应 yt-navigate-finish、popstate 与 URL 轮询并对相同 URL 去重', () => {
    vi.useFakeTimers();
    let currentHref = 'https://www.youtube.com/';
    const seen: string[] = [];

    const stop = observeYouTubeNavigation((url) => seen.push(url), {
      getUrl: () => currentHref,
      pollIntervalMs: 500,
    });

    try {
      // 同 URL 触发事件不重复通知
      window.dispatchEvent(new Event('yt-navigate-finish'));
      expect(seen).toEqual([]);

      // URL 变化 + yt-navigate-finish 立即通知一次
      currentHref = 'https://www.youtube.com/watch?v=vidA';
      window.dispatchEvent(new Event('yt-navigate-finish'));
      window.dispatchEvent(new Event('yt-page-data-updated'));
      expect(seen).toEqual(['https://www.youtube.com/watch?v=vidA']);

      // popstate 后退到另一个视频
      currentHref = 'https://www.youtube.com/watch?v=vidB';
      window.dispatchEvent(new PopStateEvent('popstate'));
      expect(seen).toEqual([
        'https://www.youtube.com/watch?v=vidA',
        'https://www.youtube.com/watch?v=vidB',
      ]);

      // 无自定义事件环境（如移动端页）由轮询兜底捕获
      currentHref = 'https://www.youtube.com/watch?v=vidC';
      vi.advanceTimersByTime(500);
      expect(seen).toEqual([
        'https://www.youtube.com/watch?v=vidA',
        'https://www.youtube.com/watch?v=vidB',
        'https://www.youtube.com/watch?v=vidC',
      ]);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});

describe('startYouTubeSubtitleSource（端到端桥接 + 路由跟随 + 切视频防串）', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await saveSettings(DEFAULT_SETTINGS);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('首屏拿取 cue 数组，yt-navigate-finish 切视频后 videoId 与 cue 同步切换且旧慢响应不串台', async () => {
    let activeVideoId = 'vid_first';
    const player = document.createElement('div');
    player.id = 'movie_player';
    (player as unknown as { getPlayerResponse: () => PlayerResponseLike }).getPlayerResponse =
      () => ({
        videoDetails: { videoId: activeVideoId },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                languageCode: 'en',
                baseUrl: `https://www.youtube.com/api/timedtext?v=${activeVideoId}&lang=en`,
              },
            ],
          },
        },
      });
    document.body.appendChild(player);

    // 控制 vid_slow 的字幕网络请求延迟返回，验证快速切到 vid_second 后不会把 vid_slow 的字幕发出
    const slowGate: { resolve?: (value: unknown) => void } = {};
    const fetchMock = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes('v=vid_slow')) {
        return new Promise((resolve) => {
          slowGate.resolve = resolve;
        });
      }
      const v = new URL(url).searchParams.get('v');
      return Promise.resolve({
        ok: true,
        text: async () =>
          JSON.stringify({
            events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: `subtitle-for-${v}` }] }],
          }),
      });
    });

    const stopMain = startMainWorldBridge({
      pollIntervalMs: 10,
      pollTimeoutMs: 500,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    let currentUrl = 'https://www.youtube.com/watch?v=vid_first';
    const states: YouTubeSubtitleState[] = [];

    const source = startYouTubeSubtitleSource({
      onStateChange: (state) => states.push(state),
      getUrl: () => currentUrl,
      pollIntervalMs: 5000,
    });

    try {
      await vi.waitFor(() => {
        expect(states.some((s) => s.kind === 'ready' && s.videoId === 'vid_first')).toBe(true);
      });

      const firstReady = states.find((s) => s.kind === 'ready' && s.videoId === 'vid_first');
      expect(firstReady).toMatchObject({
        kind: 'ready',
        videoId: 'vid_first',
        cues: [{ startMs: 0, endMs: 1000, text: 'subtitle-for-vid_first' }],
      });

      // 导航到慢视频 vid_slow，未等返回立刻再切到 vid_second
      activeVideoId = 'vid_slow';
      currentUrl = 'https://www.youtube.com/watch?v=vid_slow';
      window.dispatchEvent(new Event('yt-navigate-finish'));

      await vi.waitFor(() => {
        expect(slowGate.resolve).toBeDefined();
      });

      activeVideoId = 'vid_second';
      currentUrl = 'https://www.youtube.com/watch?v=vid_second';
      window.dispatchEvent(new Event('yt-navigate-finish'));

      // 让先前卡住的 vid_slow 请求此刻才返回
      slowGate.resolve?.({
        ok: true,
        text: async () =>
          JSON.stringify({
            events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'STALE-SLOW' }] }],
          }),
      });

      await vi.waitFor(() => {
        expect(states.at(-1)).toMatchObject({
          kind: 'ready',
          videoId: 'vid_second',
          cues: [{ startMs: 0, endMs: 1000, text: 'subtitle-for-vid_second' }],
        });
      });

      // 断言整个生命周期内从未发出 vid_slow 的 ready 状态
      expect(states.some((s) => s.kind === 'ready' && s.videoId === 'vid_slow')).toBe(false);

      // 切换到 Shorts 页面应立即给出 unsupported(shorts)
      currentUrl = 'https://www.youtube.com/shorts/s_99';
      window.dispatchEvent(new Event('yt-navigate-finish'));
      await vi.waitFor(() => {
        expect(states.at(-1)).toEqual({
          kind: 'unsupported',
          reason: 'shorts',
          videoId: 's_99',
        });
      });
    } finally {
      source.destroy();
      stopMain();
    }
  });

  it('门控关闭时不请求桥且发出 idle 状态', async () => {
    await saveSettings({
      ...DEFAULT_SETTINGS,
      features: { ...DEFAULT_SETTINGS.features, youtubeSubtitles: false },
    });

    const states: YouTubeSubtitleState[] = [];
    const bridgeSpy = {
      requestSubtitles: vi.fn(),
      destroy: vi.fn(),
    };

    const source = startYouTubeSubtitleSource({
      onStateChange: (s) => states.push(s),
      getUrl: () => 'https://www.youtube.com/watch?v=vid_disabled',
      bridge: bridgeSpy,
    });

    try {
      await vi.waitFor(() => {
        expect(states).toContainEqual({ kind: 'idle' });
      });
      expect(bridgeSpy.requestSubtitles).not.toHaveBeenCalled();
    } finally {
      source.destroy();
    }
  });
});
