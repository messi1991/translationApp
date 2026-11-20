import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '@/modules/settings';
import { toggleFeatureSwitch, toggleSiteEnabled } from '@/modules/popup';
import {
  clearCache,
  hasInternalErrorLeak,
  registerTranslateHandler,
  requestClearCache,
} from '@/modules/translation-core';
import { BUTTON_ID, CARD_ID, startSelectionTranslate } from '@/modules/selection-translate';
import { OVERLAY_HOST_ID } from '@/modules/subtitle-pipeline';
import { startMainWorldBridge, startYouTubeSubtitles } from '@/modules/youtube-subtitles';

// 构建产物安全审计（若已执行过 pnpm build，则直接扫描真实编译后的 content script 产物）
const builtSelectionJs = await import('../.output/chrome-mv3/content-scripts/selection.js?raw').catch(
  () => null,
);
const builtYoutubeJs = await import('../.output/chrome-mv3/content-scripts/youtube.js?raw').catch(
  () => null,
);
const builtYoutubeMainJs = await import(
  '../.output/chrome-mv3/content-scripts/youtube-main.js?raw'
).catch(() => null);

describe('安全检查：大模型 API Key 与外部翻译请求绝不进入 content script（T14）', () => {
  it('构建产物 content-scripts 不包含任何翻译引擎端点、Authorization 头或 OpenAI 请求代码', () => {
    const bundles = [builtSelectionJs?.default, builtYoutubeJs?.default, builtYoutubeMainJs?.default].filter(
      (x): x is string => typeof x === 'string',
    );
    for (const code of bundles) {
      expect(code).not.toContain('chat/completions');
      expect(code).not.toContain('edge.microsoft.com/translate');
      expect(code).not.toMatch(/Bearer\s+/);
      expect(code).not.toContain('sk-');
    }
  });

  it('MAIN world 注入脚本完全零扩展权限依赖，不触碰 chrome.storage 或任何配置字段', () => {
    if (!builtYoutubeMainJs) return;
    expect(builtYoutubeMainJs.default).not.toContain('local:settings');
    expect(builtYoutubeMainJs.default).not.toContain('apiKey');
    expect(builtYoutubeMainJs.default).not.toContain('openai-compatible');
  });

  it('运行时划词与字幕消息往返（request / response）全程不携带 apiKey', async () => {
    fakeBrowser.reset();
    const secretKey = 'sk-super-secret-regression-9999';
    await saveSettings({
      ...DEFAULT_SETTINGS,
      engine: 'openai-compatible',
      engines: {
        'openai-compatible': {
          baseUrl: 'https://api.example.com/v1',
          apiKey: secretKey,
          model: 'gpt-4o-mini',
        },
      },
    });

    const wirePayloads: string[] = [];
    fakeBrowser.runtime.onMessage.addListener((msg) => {
      wirePayloads.push(JSON.stringify(msg));
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        // 确认密钥仅出现在 background 发出的受控 fetch Authorization 头中
        const headers = init?.headers as Record<string, string> | undefined;
        expect(headers?.authorization).toBe(`Bearer ${secretKey}`);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '安全译文' } }] }),
          { status: 200 },
        );
      }),
    );

    const unregister = registerTranslateHandler();
    const stopSel = await startSelectionTranslate({ url: 'https://news.example.com/post' });

    try {
      const p = document.createElement('p');
      p.textContent = 'Confidential check';
      document.body.appendChild(p);
      const range = document.createRange();
      range.selectNodeContents(p);
      range.getBoundingClientRect = () =>
        ({ top: 40, left: 40, right: 140, bottom: 60, width: 100, height: 20 }) as DOMRect;
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await new Promise((r) => setTimeout(r, 240));

      document.getElementById(BUTTON_ID)?.shadowRoot?.querySelector('button')?.click();
      await vi.waitFor(() => {
        const card = document.getElementById(CARD_ID)?.shadowRoot;
        expect(card?.querySelector('.st-translated')?.textContent).toBe('安全译文');
      });

      // 消息总线与页面 DOM 均不含密钥
      for (const payload of wirePayloads) {
        expect(payload).not.toContain(secretKey);
      }
      expect(document.documentElement.innerHTML).not.toContain(secretKey);
      expect(document.getElementById(CARD_ID)?.shadowRoot?.innerHTML ?? '').not.toContain(
        secretKey,
      );
    } finally {
      stopSel();
      unregister();
      document.body.innerHTML = '';
      vi.unstubAllGlobals();
    }
  });
});

describe('全链路回归测试集：设置 + 划词 + 字幕 + 二级缓存 + 黑名单 + 限流恢复（T14）', () => {
  let unregisterBg: () => void = () => {};

  beforeEach(async () => {
    fakeBrowser.reset();
    await clearCache({ persistent: true });
    await saveSettings(DEFAULT_SETTINGS);
    unregisterBg = registerTranslateHandler({ baseDelayMs: 5, maxDelayMs: 20, maxRetries: 2 });
  });

  afterEach(() => {
    unregisterBg();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('跨模块全流程：划词命中缓存 → 清缓存重发 → 429 自动退避恢复 → 站点拉黑即时停用 → YouTube 双语字幕联动', async () => {
    let translateCalls = 0;
    let trigger429Once = false;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('youtube.com/api/timedtext')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                events: [{ tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'Hello YouTube' }] }],
              }),
          };
        }
        if (url.includes('edge.microsoft.com/translate/translatetext')) {
          translateCalls += 1;
          if (trigger429Once) {
            trigger429Once = false;
            return new Response('rate limit', { status: 429 });
          }
          const texts = JSON.parse((init?.body as string) ?? '[]') as string[];
          return new Response(
            JSON.stringify(texts.map((t) => ({ translations: [{ text: `中:${t}` }] }))),
            { status: 200 },
          );
        }
        throw new Error('Unexpected URL: ' + url);
      }),
    );

    // 1. 划词首次请求网络，二次翻译同文本命中二级缓存（translateCalls 不增加）
    const stopSel = await startSelectionTranslate({ url: 'https://blog.example.com/1' });
    const span = document.createElement('span');
    span.textContent = 'Cache me';
    document.body.appendChild(span);
    const range = document.createRange();
    range.selectNodeContents(span);
    range.getBoundingClientRect = () =>
      ({ top: 50, left: 50, right: 130, bottom: 70, width: 80, height: 20 }) as DOMRect;

    const selectAndTranslate = async () => {
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await new Promise((r) => setTimeout(r, 230));
      document.getElementById(BUTTON_ID)?.shadowRoot?.querySelector('button')?.click();
      await vi.waitFor(() => {
        const text = document
          .getElementById(CARD_ID)
          ?.shadowRoot?.querySelector('.st-translated')?.textContent;
        expect(text).toBe('中:Cache me');
      });
    };

    await selectAndTranslate();
    expect(translateCalls).toBe(1);

    // 关闭卡片再对同一文本划词 -> 命中缓存，网络请求仍为 1
    (
      document.getElementById(CARD_ID)?.shadowRoot?.querySelector('.st-close') as HTMLElement
    )?.click();
    await selectAndTranslate();
    expect(translateCalls).toBe(1);

    // 2. 清空缓存 + 模拟上游瞬时 429 -> 自动指数退避重试并成功恢复
    await requestClearCache();
    (
      document.getElementById(CARD_ID)?.shadowRoot?.querySelector('.st-close') as HTMLElement
    )?.click();
    trigger429Once = true;
    await selectAndTranslate();
    // 1 (首次) + 1 (429) + 1 (退避重试成功) = 3
    expect(translateCalls).toBe(3);

    // 3. 通过 popup 纯函数将当前域名拉黑 -> 划词浮层立即销毁
    await saveSettings(toggleSiteEnabled(await getSettings(), 'blog.example.com', false));
    await vi.waitFor(() => {
      expect(document.getElementById(BUTTON_ID)).toBeNull();
      expect(document.getElementById(CARD_ID)).toBeNull();
    });
    stopSel();

    // 4. YouTube 观看页双语字幕全链路 + 开关实时关闭
    document.body.innerHTML = '';
    const player = document.createElement('div');
    player.id = 'movie_player';
    (player as unknown as { getPlayerResponse: () => unknown }).getPlayerResponse = () => ({
      videoDetails: { videoId: 'reg_vid' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=reg_vid' },
          ],
        },
      },
    });
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { get: () => 0.5 });
    Object.defineProperty(video, 'paused', { get: () => false });
    (video as unknown as { requestVideoFrameCallback: () => number }).requestVideoFrameCallback =
      () => 1;
    player.appendChild(video);
    document.body.appendChild(player);

    const stopMain = startMainWorldBridge({ pollIntervalMs: 10, pollTimeoutMs: 400 });
    const ytApp = startYouTubeSubtitles({
      getUrl: () => 'https://www.youtube.com/watch?v=reg_vid',
      pollIntervalMs: 5000,
    });

    try {
      await vi.waitFor(() => {
        const shadow = player.querySelector(`#${OVERLAY_HOST_ID}`)?.shadowRoot;
        expect(shadow?.querySelector('.sp-translated')?.textContent).toBe('中:Hello YouTube');
      });

      // 通过 popup 开关关闭 YouTube 字幕 -> 叠加层立即移除
      await saveSettings(toggleFeatureSwitch(await getSettings(), 'youtubeSubtitles', false));
      await vi.waitFor(() => {
        expect(player.querySelector(`#${OVERLAY_HOST_ID}`)).toBeNull();
      });
    } finally {
      ytApp.destroy();
      stopMain();
    }

    // 校验错误文案无任何内部泄露迹象
    expect(hasInternalErrorLeak('请求过于频繁，请稍后再试')).toBe(false);
  });
});
