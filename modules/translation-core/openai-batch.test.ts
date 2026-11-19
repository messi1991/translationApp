import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAiProvider } from './openai';
import type { Provider, TranslateManyInput, TranslationResult } from './provider';

const CONFIG = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test-key',
  model: 'deepseek-chat',
};

let fetchStub: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchStub = vi.fn();
  vi.stubGlobal('fetch', fetchStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const okResponse = (content: string) =>
  new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const errorResponse = (status: number) =>
  new Response(JSON.stringify({ error: { message: 'boom' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** 调用可选方法 translateMany，缺失时直接失败（本引擎必须实现批量） */
async function translateManyOf(
  provider: Provider,
  input: TranslateManyInput,
): Promise<TranslationResult[]> {
  if (!provider.translateMany) throw new Error('openai 引擎必须实现 translateMany');
  return provider.translateMany(input);
}

describe('OpenAI 兼容引擎：批量合并请求', () => {
  it('translateMany 一次请求翻多条，结果按输入顺序返回', async () => {
    fetchStub.mockResolvedValueOnce(okResponse('["你好","世界"]'));

    const results = await translateManyOf(createOpenAiProvider(CONFIG), {
      texts: ['Hello', 'World'],
      to: 'zh-CN',
    });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.text)).toEqual(['你好', '世界']);
    expect(results.every((r) => r.engine === 'openai-compatible')).toBe(true);
  });

  it('空数组不发请求，直接返回空结果', async () => {
    const results = await translateManyOf(createOpenAiProvider(CONFIG), {
      texts: [],
      to: 'zh-CN',
    });

    expect(fetchStub).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('批量结果条数与输入不符时归为 unknown', async () => {
    fetchStub.mockResolvedValueOnce(okResponse('["只有一条"]'));

    await expect(
      translateManyOf(createOpenAiProvider(CONFIG), { texts: ['a', 'b'], to: 'zh-CN' }),
    ).rejects.toMatchObject({ code: 'unknown' });
  });

  it('批量结果允许被 ```json 代码块包裹', async () => {
    fetchStub.mockResolvedValueOnce(okResponse('```json\n["你好","世界"]\n```'));

    const results = await translateManyOf(createOpenAiProvider(CONFIG), {
      texts: ['Hello', 'World'],
      to: 'zh-CN',
    });

    expect(results.map((r) => r.text)).toEqual(['你好', '世界']);
  });
});

describe('OpenAI 兼容引擎：testConnection', () => {
  it('成功时不抛错', async () => {
    fetchStub.mockResolvedValueOnce(okResponse('ok'));

    await expect(createOpenAiProvider(CONFIG).testConnection()).resolves.toBeUndefined();
  });

  it('鉴权失败时抛 authentication', async () => {
    fetchStub.mockResolvedValueOnce(errorResponse(401));

    await expect(createOpenAiProvider(CONFIG).testConnection()).rejects.toMatchObject({
      code: 'authentication',
    });
  });
});
