import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationError } from './error';
import { createOpenAiProvider } from './openai';

const CONFIG = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test-key',
  model: 'deepseek-chat',
};

/** 全局 fetch 存根（每测独立） */
let fetchStub: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchStub = vi.fn();
  vi.stubGlobal('fetch', fetchStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** 取第 n 次 fetch 的 URL 与 init（避免 mock.calls 索引的 possibly-undefined 噪音） */
function callAt(index: number): { url: string; init: RequestInit } {
  const call = fetchStub.mock.calls[index] as [string, RequestInit] | undefined;
  if (!call) throw new Error(`第 ${index} 次 fetch 未发生`);
  return { url: call[0], init: call[1] };
}

/** 请求 body 中本测试关心的字段 */
interface ChatBody {
  model: string;
  stream: boolean;
  messages: Array<{ role: string; content: string }>;
}

/** 取第 n 次请求的 system 提示词（缺失视为测试失败） */
function systemPromptAt(index: number): string {
  const first = bodyAt(index).messages[0];
  if (!first) throw new Error(`第 ${index} 次请求缺少 system 消息`);
  return first.content;
}

/** 取第 n 次请求的 JSON body */
function bodyAt(index: number): ChatBody {
  return JSON.parse(callAt(index).init.body as string) as ChatBody;
}

/** 构造一次性成功的 chat completions 响应 */
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

describe('OpenAI 兼容引擎：成功路径', () => {
  it('把译文从 choices[0].message.content 取出', async () => {
    fetchStub.mockResolvedValueOnce(okResponse('你好'));

    const provider = createOpenAiProvider(CONFIG);
    const result = await provider.translate({ text: 'Hello', to: 'zh-CN' });

    expect(result).toEqual({ text: '你好', from: 'auto', engine: 'openai-compatible' });
  });

  it('请求打到 baseUrl + /chat/completions，带 Bearer 鉴权与指定模型', async () => {
    fetchStub.mockResolvedValueOnce(okResponse('你好'));

    await createOpenAiProvider(CONFIG).translate({ text: 'Hello', to: 'zh-CN' });

    const { url, init } = callAt(0);
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test-key');
    expect(headers['content-type']).toBe('application/json');

    const body = bodyAt(0);
    expect(body.model).toBe('deepseek-chat');
    expect(body.stream).toBe(false);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('baseUrl 末尾多余斜杠不会产生双斜杠', async () => {
    fetchStub.mockResolvedValueOnce(okResponse('hi'));

    await createOpenAiProvider({ ...CONFIG, baseUrl: 'https://api.deepseek.com/v1/' }).translate({
      text: 'Hello',
      to: 'en',
    });

    expect(callAt(0).url).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('指定源语言时在 system 提示中体现，结果回填该语言', async () => {
    fetchStub.mockResolvedValueOnce(okResponse('你好'));

    const result = await createOpenAiProvider(CONFIG).translate({
      text: 'Hello',
      to: 'zh-CN',
      from: 'en',
    });

    expect(systemPromptAt(0)).toContain('en');
    expect(result.from).toBe('en');
  });
});

describe('OpenAI 兼容引擎：错误分类', () => {
  it('401 归为 authentication', async () => {
    fetchStub.mockResolvedValueOnce(errorResponse(401));

    await expect(
      createOpenAiProvider(CONFIG).translate({ text: 'Hi', to: 'zh-CN' }),
    ).rejects.toMatchObject({ code: 'authentication' });
  });

  it('403 归为 authentication', async () => {
    fetchStub.mockResolvedValueOnce(errorResponse(403));

    await expect(
      createOpenAiProvider(CONFIG).translate({ text: 'Hi', to: 'zh-CN' }),
    ).rejects.toMatchObject({ code: 'authentication' });
  });

  it('429 归为 rate-limit', async () => {
    fetchStub.mockResolvedValueOnce(errorResponse(429));

    await expect(
      createOpenAiProvider(CONFIG).translate({ text: 'Hi', to: 'zh-CN' }),
    ).rejects.toMatchObject({ code: 'rate-limit' });
  });

  it('fetch 抛错归为 network', async () => {
    fetchStub.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(
      createOpenAiProvider(CONFIG).translate({ text: 'Hi', to: 'zh-CN' }),
    ).rejects.toMatchObject({ code: 'network' });
  });

  it('超时归为 network 且带超时说明', async () => {
    // 永不 resolve 的 fetch，配合假定时器触发 AbortController
    fetchStub.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );

    const promise = createOpenAiProvider({ ...CONFIG, timeoutMs: 50 }).translate({
      text: 'Hi',
      to: 'zh-CN',
    });

    await expect(promise).rejects.toMatchObject({ code: 'network' });
    await expect(promise).rejects.toThrow(/超时/);
  });

  it('响应体不是 JSON 归为 unknown', async () => {
    fetchStub.mockResolvedValueOnce(new Response('not json', { status: 200 }));

    await expect(
      createOpenAiProvider(CONFIG).translate({ text: 'Hi', to: 'zh-CN' }),
    ).rejects.toMatchObject({ code: 'unknown' });
  });

  it('choices 缺失或 content 为空归为 unknown', async () => {
    fetchStub.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );

    await expect(
      createOpenAiProvider(CONFIG).translate({ text: 'Hi', to: 'zh-CN' }),
    ).rejects.toMatchObject({ code: 'unknown' });
  });

  it('流式响应被误设时（SSE 文本）归为 unknown 而非崩溃', async () => {
    fetchStub.mockResolvedValueOnce(
      new Response('data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: [DONE]\n', {
        status: 200,
      }),
    );

    await expect(
      createOpenAiProvider(CONFIG).translate({ text: 'Hi', to: 'zh-CN' }),
    ).rejects.toMatchObject({ code: 'unknown' });
  });

  it('错误均为 TranslationError 实例', async () => {
    fetchStub.mockResolvedValueOnce(errorResponse(401));

    const err = await createOpenAiProvider(CONFIG)
      .translate({ text: 'Hi', to: 'zh-CN' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TranslationError);
  });
});

describe('OpenAI 兼容引擎：配置校验', () => {
  it('baseUrl 为空时直接报错，不发请求', async () => {
    await expect(
      createOpenAiProvider({ ...CONFIG, baseUrl: '' }).translate({ text: 'Hi', to: 'zh-CN' }),
    ).rejects.toMatchObject({ code: 'unknown' });

    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('apiKey 为空时直接报错，不发请求', async () => {
    await expect(
      createOpenAiProvider({ ...CONFIG, apiKey: '' }).translate({ text: 'Hi', to: 'zh-CN' }),
    ).rejects.toMatchObject({ code: 'authentication' });

    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('model 为空时直接报错，不发请求', async () => {
    await expect(
      createOpenAiProvider({ ...CONFIG, model: '' }).translate({ text: 'Hi', to: 'zh-CN' }),
    ).rejects.toMatchObject({ code: 'unknown' });

    expect(fetchStub).not.toHaveBeenCalled();
  });
});
