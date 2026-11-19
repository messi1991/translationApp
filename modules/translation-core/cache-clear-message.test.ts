import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS } from '@/modules/settings';
import { registerTranslateHandler, requestClearCache, requestTranslate } from './messaging';

let fetchMock: ReturnType<typeof vi.fn>;

const OPENAI_SETTINGS = {
  ...DEFAULT_SETTINGS,
  engine: 'openai-compatible' as const,
  engines: {
    'openai-compatible': {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'test-model',
    },
  },
};

const okChat = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: '你好' } }] }), { status: 200 });

beforeEach(async () => {
  await browser.storage.local.clear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('清除缓存消息通道', () => {
  it('清除后同一文本重新请求（两层都已清空）', async () => {
    const unregister = registerTranslateHandler();
    await browser.storage.local.set({ settings: OPENAI_SETTINGS });
    fetchMock.mockImplementation(() => Promise.resolve(okChat()));

    await requestTranslate({ text: 'Hello' });
    await requestTranslate({ text: 'Hello' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cleared = await requestClearCache();
    expect(cleared.ok).toBe(true);

    await requestTranslate({ text: 'Hello' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unregister();
  });

  it('多次清除不抛错', async () => {
    const unregister = registerTranslateHandler();

    const first = await requestClearCache();
    const second = await requestClearCache();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    unregister();
  });

  it('清除缓存不影响配置持久化', async () => {
    const unregister = registerTranslateHandler();
    await browser.storage.local.set({ settings: OPENAI_SETTINGS });

    await requestClearCache();

    const stored = await browser.storage.local.get('settings');
    expect(stored.settings).toEqual(OPENAI_SETTINGS);
    unregister();
  });
});
