import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationError } from './error';
import { createEdgeProvider } from './edge';

const ENDPOINT =
  'https://edge.microsoft.com/translate/translatetext?from=en&to=zh-Hans&isEnterpriseClient=false';

/** 构造微软翻译响应体 */
const microsoftResponse = (texts: string[]) =>
  texts.map((text) => ({
    translations: [{ text, to: 'zh-Hans', sentLen: { srcSentLen: [1], transSentLen: [1] } }],
  }));

let fetchMock: ReturnType<typeof vi.fn>;

/** 让 mock fetch 每次调用都返回全新 Response（body 不可重复读取） */
const mockFetchResponse = (makeResponse: () => Response) => {
  fetchMock.mockImplementation(() => Promise.resolve(makeResponse()));
};

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Edge 引擎 translate', () => {
  it('成功：POST 字符串数组并返回译文', async () => {
    mockFetchResponse(() => new Response(JSON.stringify(microsoftResponse(['你好，世界'])), { status: 200 }));

    const provider = createEdgeProvider();
    const result = await provider.translate({ text: 'Hello, world', from: 'en', to: 'zh-CN' });

    expect(result.text).toBe('你好，世界');
    expect(result.from).toBe('en');
    expect(result.engine).toBe('edge');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(init?.body).toBe(JSON.stringify(['Hello, world']));
  });

  it('未传源语言时 from= 留空（自动检测）且结果 from 为 auto', async () => {
    mockFetchResponse(() => new Response(JSON.stringify(microsoftResponse(['你好'])), { status: 200 }));

    const provider = createEdgeProvider();
    const result = await provider.translate({ text: 'Hello', to: 'zh-CN' });

    expect(result.from).toBe('auto');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('from=&to=zh-Hans');
  });

  it('zh-CN/zh-TW 映射为微软码 zh-Hans/zh-Hant', async () => {
    mockFetchResponse(() => new Response(JSON.stringify(microsoftResponse(['你好'])), { status: 200 }));

    const provider = createEdgeProvider();
    await provider.translate({ text: 'Hello', to: 'zh-CN' });
    await provider.translate({ text: 'Hello', to: 'zh-TW' });

    const [url1] = fetchMock.mock.calls[0] as [string];
    const [url2] = fetchMock.mock.calls[1] as [string];
    expect(url1).toContain('to=zh-Hans');
    expect(url2).toContain('to=zh-Hant');
  });

  it('429 映射为 rate-limit', async () => {
    fetchMock.mockResolvedValue(new Response('too many requests', { status: 429 }));

    const provider = createEdgeProvider();
    const err = await provider.translate({ text: 'Hello', to: 'zh-CN' }).catch((e) => e);

    expect(err).toBeInstanceOf(TranslationError);
    expect(err.code).toBe('rate-limit');
  });

  it('网络错误（fetch reject）映射为 network', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const provider = createEdgeProvider();
    const err = await provider.translate({ text: 'Hello', to: 'zh-CN' }).catch((e) => e);

    expect(err).toBeInstanceOf(TranslationError);
    expect(err.code).toBe('network');
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it('400（不支持语言对）映射为 unsupported-language', async () => {
    fetchMock.mockResolvedValue(new Response('Unsupported language pair', { status: 400 }));

    const provider = createEdgeProvider();
    const err = await provider.translate({ text: 'Hello', to: 'zh-CN' }).catch((e) => e);

    expect(err).toBeInstanceOf(TranslationError);
    expect(err.code).toBe('unsupported-language');
  });

  it('其他非 2xx 映射为 unknown', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));

    const provider = createEdgeProvider();
    const err = await provider.translate({ text: 'Hello', to: 'zh-CN' }).catch((e) => e);

    expect(err).toBeInstanceOf(TranslationError);
    expect(err.code).toBe('unknown');
  });

  it('响应格式异常映射为 unknown', async () => {
    fetchMock.mockResolvedValue(new Response('{"unexpected":true}', { status: 200 }));

    const provider = createEdgeProvider();
    const err = await provider.translate({ text: 'Hello', to: 'zh-CN' }).catch((e) => e);

    expect(err).toBeInstanceOf(TranslationError);
    expect(err.code).toBe('unknown');
  });
});

describe('Edge 引擎 translateMany', () => {
  it('一次请求合并多条文本，返回顺序与输入一致', async () => {
    mockFetchResponse(
      () => new Response(JSON.stringify(microsoftResponse(['你好', '世界'])), { status: 200 }),
    );

    const provider = createEdgeProvider();
    if (!provider.translateMany) throw new Error('edge 引擎必须实现 translateMany');
    const results = await provider.translateMany({ texts: ['Hello', 'World'], from: 'en', to: 'zh-CN' });

    expect(results.map((r) => r.text)).toEqual(['你好', '世界']);
    expect(results.every((r) => r.engine === 'edge' && r.from === 'en')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init?.body).toBe(JSON.stringify(['Hello', 'World']));
  });

  it('空数组不发请求', async () => {
    const provider = createEdgeProvider();
    if (!provider.translateMany) throw new Error('edge 引擎必须实现 translateMany');

    await expect(provider.translateMany({ texts: [], to: 'zh-CN' })).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('响应条数与请求不一致时判定为异常响应', async () => {
    mockFetchResponse(
      () => new Response(JSON.stringify(microsoftResponse(['只回一条'])), { status: 200 }),
    );

    const provider = createEdgeProvider();
    if (!provider.translateMany) throw new Error('edge 引擎必须实现 translateMany');
    const err = await provider
      .translateMany({ texts: ['Hello', 'World'], to: 'zh-CN' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TranslationError);
    expect(err.code).toBe('unknown');
  });
});

describe('Edge 引擎 testConnection', () => {
  it('连通时 resolve 不抛错', async () => {
    mockFetchResponse(() => new Response(JSON.stringify(microsoftResponse(['测试'])), { status: 200 }));

    const provider = createEdgeProvider();
    await expect(provider.testConnection()).resolves.toBeUndefined();
  });

  it('失败时抛出带码的 TranslationError', async () => {
    fetchMock.mockResolvedValue(new Response('too many requests', { status: 429 }));

    const provider = createEdgeProvider();
    const err = await provider.testConnection().catch((e) => e);

    expect(err).toBeInstanceOf(TranslationError);
    expect(err.code).toBe('rate-limit');
  });
});
