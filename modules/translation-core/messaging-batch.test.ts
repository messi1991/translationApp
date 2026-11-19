import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS } from '@/modules/settings';
import { registerTranslateHandler, requestTranslateMany } from './messaging';

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

/** 批量 chat completions 成功响应 */
const batchResponse = (items: string[]) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(items) } }] }), {
    status: 200,
  });

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await browser.storage.local.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('批量翻译消息通道', () => {
  it('引擎支持批量时一次请求返回多条译文', async () => {
    const unregister = registerTranslateHandler();
    await browser.storage.local.set({ settings: OPENAI_SETTINGS });
    fetchMock.mockImplementation(() => Promise.resolve(batchResponse(['你好', '世界'])));

    const response = await requestTranslateMany({ texts: ['Hello', 'World'] });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result.map((r) => r.text)).toEqual(['你好', '世界']);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unregister();
  });

  it('引擎不支持批量（edge）时逐条 fallback，结果仍按顺序', async () => {
    const unregister = registerTranslateHandler();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const texts = JSON.parse(init.body as string) as string[];
      return Promise.resolve(
        new Response(
          JSON.stringify(texts.map((t) => ({ translations: [{ text: `译:${t}`, to: 'zh-Hans' }] }))),
          { status: 200 },
        ),
      );
    });

    const response = await requestTranslateMany({ texts: ['a', 'b'] });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result.map((r) => r.text)).toEqual(['译:a', '译:b']);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unregister();
  });

  it('目标语言缺省取 settings.targetLanguage', async () => {
    const unregister = registerTranslateHandler();
    await browser.storage.local.set({
      settings: { ...OPENAI_SETTINGS, targetLanguage: 'ja' },
    });
    fetchMock.mockImplementation(() => Promise.resolve(batchResponse(['こんにちは'])));

    await requestTranslateMany({ texts: ['Hello'] });

    const call = fetchMock.mock.calls[0] as [string, RequestInit] | undefined;
    if (!call) throw new Error('未发出请求');
    const body = JSON.parse(call[1].body as string);
    expect(body.messages[0].content).toContain('ja');
    unregister();
  });

  it('空数组不发请求，返回空结果', async () => {
    const unregister = registerTranslateHandler();
    await browser.storage.local.set({ settings: OPENAI_SETTINGS });

    const response = await requestTranslateMany({ texts: [] });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toEqual([]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    unregister();
  });

  it('失败时透传错误码', async () => {
    const unregister = registerTranslateHandler();
    await browser.storage.local.set({ settings: OPENAI_SETTINGS });
    fetchMock.mockImplementation(() => Promise.resolve(new Response('nope', { status: 401 })));

    const response = await requestTranslateMany({ texts: ['Hello'] });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.code).toBe('authentication');
    }
    unregister();
  });
});
