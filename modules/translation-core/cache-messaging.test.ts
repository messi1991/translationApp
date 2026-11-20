import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS } from '@/modules/settings';
import { clearCache } from './cache';
import { registerTranslateHandler, requestTranslate } from './messaging';

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

const okChat = (content = '你好') =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

beforeEach(async () => {
  await browser.storage.local.clear();
  await clearCache({ persistent: true });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('消息层缓存生效', () => {
  it('同文本连续两次划词只发一次网络请求', async () => {
    const unregister = registerTranslateHandler();
    await browser.storage.local.set({ settings: OPENAI_SETTINGS });
    fetchMock.mockImplementation(() => Promise.resolve(okChat()));

    await requestTranslate({ text: 'Hello' });
    await requestTranslate({ text: 'Hello' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    unregister();
  });

  it('换目标语言后重新请求', async () => {
    const unregister = registerTranslateHandler();
    await browser.storage.local.set({ settings: OPENAI_SETTINGS });
    fetchMock.mockImplementation(() => Promise.resolve(okChat()));

    await requestTranslate({ text: 'Hello', to: 'zh-CN' });
    await requestTranslate({ text: 'Hello', to: 'ja' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    unregister();
  });

  it('清空持久缓存后重新请求', async () => {
    const unregister = registerTranslateHandler();
    await browser.storage.local.set({ settings: OPENAI_SETTINGS });
    fetchMock.mockImplementation(() => Promise.resolve(okChat()));

    await requestTranslate({ text: 'Hello' });
    await clearCache({ persistent: true });
    await requestTranslate({ text: 'Hello' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    unregister();
  });

  it('失败结果不入缓存，重试会真正重发', async () => {
    const unregister = registerTranslateHandler();
    await browser.storage.local.set({ settings: OPENAI_SETTINGS });
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response('x', { status: 500 })));
    fetchMock.mockImplementation(() => Promise.resolve(okChat()));

    const first = await requestTranslate({ text: 'Hello' });
    const second = await requestTranslate({ text: 'Hello' });

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unregister();
  });
});
