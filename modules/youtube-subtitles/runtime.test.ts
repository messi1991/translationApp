import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_SETTINGS, saveSettings } from '@/modules/settings';
import { registerTranslateHandler } from '@/modules/translation-core';
import { HIDE_NATIVE_ATTR, OVERLAY_HOST_ID } from '@/modules/subtitle-pipeline';
import { startMainWorldBridge, type PlayerResponseLike } from './main-world';
import { startYouTubeSubtitles } from './runtime';

function mountYouTubeDom(options: {
  playerId?: string;
  getPlayerResponse?: () => PlayerResponseLike;
  currentTime?: number;
}) {
  const container = document.createElement('div');
  container.id = options.playerId ?? 'movie_player';
  if (options.getPlayerResponse) {
    (container as unknown as { getPlayerResponse: () => PlayerResponseLike }).getPlayerResponse =
      options.getPlayerResponse;
  }

  const video = document.createElement('video');
  Object.defineProperty(video, 'currentTime', {
    get: () => options.currentTime ?? 0.5,
    configurable: true,
  });
  Object.defineProperty(video, 'paused', {
    get: () => false,
    configurable: true,
  });
  (
    video as unknown as {
      requestVideoFrameCallback: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
      cancelVideoFrameCallback: () => void;
    }
  ).requestVideoFrameCallback = () => 1;
  (video as unknown as { cancelVideoFrameCallback: () => void }).cancelVideoFrameCallback = () => {};

  container.appendChild(video);
  document.body.appendChild(container);
  return { container, video };
}

describe('startYouTubeSubtitles（T11 端到端串联）', () => {
  let unregisterBg: () => void = () => {};

  beforeEach(async () => {
    fakeBrowser.reset();
    await saveSettings(DEFAULT_SETTINGS);
    unregisterBg = registerTranslateHandler();
  });

  afterEach(() => {
    unregisterBg();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('观看页全链路：MAIN 桥拉取 json3 → pipeline 重组调度 → background Edge 引擎翻译 → Shadow DOM 双语渲染；关闭开关立即恢复原字幕', async () => {
    const { container } = mountYouTubeDom({
      currentTime: 0.5,
      getPlayerResponse: () => ({
        videoDetails: { videoId: 'e2e_vid' },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                languageCode: 'en',
                baseUrl: 'https://www.youtube.com/api/timedtext?v=e2e_vid&lang=en',
              },
            ],
          },
        },
      }),
    });

    // mock 全局 fetch：同时服务于 MAIN world 的 timedtext json3 拉取与 background 的 Edge 翻译请求
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('youtube.com/api/timedtext')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                events: [
                  { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'Good morning!' }] },
                ],
              }),
          };
        }
        if (url.includes('edge.microsoft.com/translate/translatetext')) {
          return {
            ok: true,
            status: 200,
            json: async () => [{ translations: [{ text: '早上好！' }], detectedLanguage: { language: 'en' } }],
          };
        }
        throw new Error('Unexpected fetch: ' + url);
      }),
    );

    const stopMain = startMainWorldBridge({ pollIntervalMs: 10, pollTimeoutMs: 500 });
    const app = startYouTubeSubtitles({
      getUrl: () => 'https://www.youtube.com/watch?v=e2e_vid',
      pollIntervalMs: 5000,
    });

    try {
      await vi.waitFor(() => {
        const shadow = container.querySelector(`#${OVERLAY_HOST_ID}`)?.shadowRoot;
        expect(shadow?.querySelector('.sp-original')?.textContent).toBe('Good morning!');
        expect(shadow?.querySelector('.sp-translated')?.textContent).toBe('早上好！');
      });
      // 双语字幕启用期间隐藏原字幕
      expect(container.hasAttribute(HIDE_NATIVE_ATTR)).toBe(true);

      // 动态关闭 youtubeSubtitles 开关 -> 无需刷新页面立即移除双语叠加并恢复原字幕
      await saveSettings({
        ...DEFAULT_SETTINGS,
        features: { ...DEFAULT_SETTINGS.features, youtubeSubtitles: false },
      });

      await vi.waitFor(() => {
        expect(container.querySelector(`#${OVERLAY_HOST_ID}`)).toBeNull();
        expect(container.hasAttribute(HIDE_NATIVE_ATTR)).toBe(false);
      });
    } finally {
      app.destroy();
      stopMain();
      vi.unstubAllGlobals();
    }
  });

  it('Shorts 与直播页面显示不支持提示条，且不隐藏原字幕、不抛异常', async () => {
    const shortsContainer = document.createElement('div');
    shortsContainer.id = 'shorts-player';
    document.body.appendChild(shortsContainer);

    let currentUrl = 'https://www.youtube.com/shorts/short_abc';
    const app = startYouTubeSubtitles({
      getUrl: () => currentUrl,
      pollIntervalMs: 5000,
    });

    try {
      await vi.waitFor(() => {
        const shadow = shortsContainer.querySelector(`#${OVERLAY_HOST_ID}`)?.shadowRoot;
        expect(shadow?.querySelector('.sp-notice')?.textContent).toContain('Shorts');
      });
      expect(shortsContainer.hasAttribute(HIDE_NATIVE_ATTR)).toBe(false);

      // 切换到直播观看页
      shortsContainer.remove();
      const { container: liveContainer } = mountYouTubeDom({
        getPlayerResponse: () => ({
          videoDetails: { videoId: 'live_01', isLiveContent: true },
        }),
      });

      const stopMain = startMainWorldBridge({ pollIntervalMs: 10, pollTimeoutMs: 500 });
      currentUrl = 'https://www.youtube.com/watch?v=live_01';
      window.dispatchEvent(new Event('yt-navigate-finish'));

      try {
        await vi.waitFor(() => {
          const shadow = liveContainer.querySelector(`#${OVERLAY_HOST_ID}`)?.shadowRoot;
          expect(shadow?.querySelector('.sp-notice')?.textContent).toContain('直播');
        });
        expect(liveContainer.hasAttribute(HIDE_NATIVE_ATTR)).toBe(false);
      } finally {
        stopMain();
      }
    } finally {
      app.destroy();
    }
  });

  it('桥或字幕拉取失败时静默降级：恢复原字幕、不遗留叠加层、不向外抛出未捕获异常', async () => {
    const { container } = mountYouTubeDom({
      getPlayerResponse: () => ({
        videoDetails: { videoId: 'broken_vid' },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=broken_vid' },
            ],
          },
        },
      }),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => '' })),
    );

    const stopMain = startMainWorldBridge({ pollIntervalMs: 10, pollTimeoutMs: 300 });
    const app = startYouTubeSubtitles({
      getUrl: () => 'https://www.youtube.com/watch?v=broken_vid',
      pollIntervalMs: 5000,
    });

    try {
      await new Promise((r) => setTimeout(r, 80));
      expect(container.hasAttribute(HIDE_NATIVE_ATTR)).toBe(false);
      expect(container.querySelector(`#${OVERLAY_HOST_ID}`)).toBeNull();
    } finally {
      app.destroy();
      stopMain();
      vi.unstubAllGlobals();
    }
  });
});
