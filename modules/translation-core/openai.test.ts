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
    // user 消息带指令与定界符，原文包裹在 <text> 中（抗忽略 system 的端点）
    expect(body.messages[1]?.role).toBe('user');
    expect(body.messages[1]?.content).toContain('<text>\nHello\n</text>');
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

describe('OpenAI 兼容引擎：目标语言表达', () => {
  /** 捕获本次请求的 system 提示；同一用例内可多次调用 */
  const promptFor = async (to: string, from?: string): Promise<string> => {
    const before = fetchStub.mock.calls.length;
    fetchStub.mockResolvedValueOnce(okResponse('x'));
    await createOpenAiProvider(CONFIG).translate({ text: 'Hello', to, from });
    return systemPromptAt(before);
  };

  it('system 提示含目标语言的自然语言名，而非只给 BCP-47 码', async () => {
    const prompt = await promptFor('zh-CN');

    expect(prompt).toContain('简体中文');
    expect(prompt).toContain('Simplified Chinese');
  });

  it('zh-TW 明确要求繁体，与 zh-CN 的提示可区分', async () => {
    const simplified = await promptFor('zh-CN');
    const traditional = await promptFor('zh-TW');

    expect(traditional).toContain('繁體中文');
    expect(traditional).toContain('Traditional Chinese');
    expect(traditional).not.toBe(simplified);
    expect(traditional).not.toContain('简体中文');
  });

  it('常见目标语言都有自然语言名（不留裸码）', async () => {
    const cases: Array<[string, string]> = [
      ['en', 'English'],
      ['ja', '日本語'],
      ['ko', '한국어'],
      ['fr', 'Français'],
      ['de', 'Deutsch'],
      ['es', 'Español'],
      ['ru', 'Русский'],
    ];

    for (const [code, name] of cases) {
      expect(await promptFor(code)).toContain(name);
    }
  });

  it('未知语言码原样透传，不缩成空串', async () => {
    expect(await promptFor('pt-BR')).toContain('pt-BR');
  });

  it('源语言为 auto 时不声明源语言，交给模型自动识别', async () => {
    const prompt = await promptFor('zh-CN', 'auto');

    expect(prompt).not.toContain('auto');
    expect(prompt).toContain('自动识别');
  });

  it('明确源语言时提示中同时给出码与自然语言名', async () => {
    const prompt = await promptFor('zh-CN', 'en');

    expect(prompt).toContain('English');
  });

  it('强调只输出译文，禁止附加解释或原文', async () => {
    const prompt = await promptFor('zh-CN');

    expect(prompt).toContain('直接输出译文');
  });
});

describe('OpenAI 兼容引擎：抗「模型不翻译」', () => {
  /** 取第 n 次请求的 user 消息 */
  function userPromptAt(index: number): string {
    const message = bodyAt(index).messages[1];
    if (!message) throw new Error(`第 ${index} 次请求缺少 user 消息`);
    return message.content;
  }

  it('翻译指令同时出现在 user 消息中（不只依赖 system role）', async () => {
    fetchStub.mockResolvedValueOnce(okResponse('你好'));

    await createOpenAiProvider(CONFIG).translate({ text: 'Hello', to: 'zh-CN' });

    const user = userPromptAt(0);
    // 有些兼容端点忽略 system role，仅靠 user 也必须能判断这是翻译任务
    expect(user).toContain('简体中文');
    expect(user).toContain('Hello');
    expect(user).toMatch(/翻译/);
  });

  it('user 消息明确禁止对话式回应（如「你的消息似乎被截断了」）', async () => {
    fetchStub.mockResolvedValueOnce(okResponse('你好'));

    await createOpenAiProvider(CONFIG).translate({ text: 'I have t', to: 'zh-CN' });

    const user = userPromptAt(0);
    expect(user).toMatch(/不要|禁止/);
    expect(user).toMatch(/回复|对话|提问/);
  });

  it('不完整句子也被当作待翻译文本，而非对话上下文', async () => {
    fetchStub.mockResolvedValueOnce(okResponse('有点紧张。我有 t'));

    await createOpenAiProvider(CONFIG).translate({ text: 'a little nervous. I have t', to: 'zh-CN' });

    const user = userPromptAt(0);
    expect(user).toContain('a little nervous. I have t');
    // 指令需说明：即使片段不完整也照译，不要追问或补全
    expect(user).toMatch(/不完整|片段|逐字/);
  });

  it('译文无内容时给出明确 user 约束，要求直接给译文', async () => {
    fetchStub.mockResolvedValueOnce(okResponse('你好'));

    await createOpenAiProvider(CONFIG).translate({ text: 'Hi', to: 'zh-CN' });

    expect(userPromptAt(0)).toMatch(/直接|只输出/);
  });
});
