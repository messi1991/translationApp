import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS } from '@/modules/settings';
import { registerTranslateHandler, requestTranslate, requestTestConnection } from './messaging';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await browser.storage.local.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('翻译消息通道', () => {
  it('content 侧发消息拿到译文（edge 引擎、目标语言缺省取 settings）', async () => {
    const unregister = registerTranslateHandler();
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify([{ translations: [{ text: '你好，世界', to: 'zh-Hans' }] }]),
          { status: 200 },
        ),
      ),
    );

    const response = await requestTranslate({ text: 'Hello, world' });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toEqual({
        text: '你好，世界',
        from: 'auto',
        engine: 'edge',
      });
    }
    unregister();
  });

  it('显式传入 to/from 时优先于 settings', async () => {
    const unregister = registerTranslateHandler();
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify([{ translations: [{ text: 'こんにちは' }] }]), { status: 200 }),
      ),
    );

    await requestTranslate({ text: 'Hello', to: 'ja', from: 'en' });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('from=en&to=ja');
    unregister();
  });

  it('引擎错误透传为 { ok:false, code, message }', async () => {
    const unregister = registerTranslateHandler();
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('too many requests', { status: 429 })),
    );

    const response = await requestTranslate({ text: 'Hello' });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.code).toBe('rate-limit');
      expect(response.message).toContain('429');
    }
    unregister();
  });

  it('openai-compatible 引擎走 chat completions 并返回译文', async () => {
    const unregister = registerTranslateHandler();
    await browser.storage.local.set({
      settings: {
        ...DEFAULT_SETTINGS,
        engine: 'openai-compatible',
        engines: {
          'openai-compatible': {
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'sk-test',
            model: 'test-model',
          },
        },
      },
    });
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: '你好' } }] }),
          { status: 200 },
        ),
      ),
    );

    const response = await requestTranslate({ text: 'Hello' });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result.text).toBe('你好');
      expect(response.result.engine).toBe('openai-compatible');
    }
    unregister();
  });

  it('openai-compatible 未配置 key 时返回 authentication', async () => {
    const unregister = registerTranslateHandler();
    await browser.storage.local.set({
      settings: { ...DEFAULT_SETTINGS, engine: 'openai-compatible' },
    });

    const response = await requestTranslate({ text: 'Hello' });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.code).toBe('authentication');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    unregister();
  });
});

describe('测试连接消息通道', () => {
  it('edge 引擎连通时 ok', async () => {
    const unregister = registerTranslateHandler();
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify([{ translations: [{ text: '连接测试' }] }]), { status: 200 }),
      ),
    );

    const response = await requestTestConnection({ engine: 'edge' });

    expect(response.ok).toBe(true);
    unregister();
  });

  it('失败时透传错误码', async () => {
    const unregister = registerTranslateHandler();
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('boom', { status: 500 })),
    );

    const response = await requestTestConnection({ engine: 'edge' });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.code).toBe('unknown');
    }
    unregister();
  });
});
