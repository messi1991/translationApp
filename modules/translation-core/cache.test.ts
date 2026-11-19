import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { withCache, clearCache } from './cache';
import type { Provider, TranslateInput, TranslationResult } from './provider';

/** 计数用的假引擎：记录真实调用次数，模拟网络开销 */
function makeProvider(engine: Provider['engine'] = 'edge') {
  const calls: TranslateInput[] = [];
  const provider: Provider = {
    engine,
    translate: async (input): Promise<TranslationResult> => {
      calls.push(input);
      return { text: `译:${input.text}`, from: input.from ?? 'auto', engine };
    },
    testConnection: async () => {},
  };
  return { provider, calls };
}

beforeEach(async () => {
  await browser.storage.local.clear();
});

afterEach(() => {
  clearCache();
});

describe('缓存装饰器：命中', () => {
  it('同键第二次调用不触发引擎（网络）', async () => {
    const { provider, calls } = makeProvider();
    const cached = withCache(provider);

    const first = await cached.translate({ text: 'Hello', to: 'zh-CN' });
    const second = await cached.translate({ text: 'Hello', to: 'zh-CN' });

    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('键含语言对：目标语言不同不命中', async () => {
    const { provider, calls } = makeProvider();
    const cached = withCache(provider);

    await cached.translate({ text: 'Hello', to: 'zh-CN' });
    await cached.translate({ text: 'Hello', to: 'ja' });

    expect(calls).toHaveLength(2);
  });

  it('键含源语言：指定 from 与不指定视为不同键', async () => {
    const { provider, calls } = makeProvider();
    const cached = withCache(provider);

    await cached.translate({ text: 'Hello', to: 'zh-CN' });
    await cached.translate({ text: 'Hello', to: 'zh-CN', from: 'en' });

    expect(calls).toHaveLength(2);
  });

  it('键含引擎：不同引擎不共享缓存', async () => {
    const edge = makeProvider('edge');
    const openai = makeProvider('openai-compatible');

    await withCache(edge.provider).translate({ text: 'Hello', to: 'zh-CN' });
    await withCache(openai.provider).translate({ text: 'Hello', to: 'zh-CN' });

    expect(edge.calls).toHaveLength(1);
    expect(openai.calls).toHaveLength(1);
  });

  it('文本首尾空白归一：去空格后同键命中', async () => {
    const { provider, calls } = makeProvider();
    const cached = withCache(provider);

    await cached.translate({ text: 'Hello', to: 'zh-CN' });
    await cached.translate({ text: '  Hello  ', to: 'zh-CN' });

    expect(calls).toHaveLength(1);
  });

  it('不缓存空文本与错误结果', async () => {
    const calls: string[] = [];
    const provider: Provider = {
      engine: 'edge',
      translate: async (input) => {
        calls.push(input.text);
        if (input.text === 'boom') throw new Error('失败');
        return { text: '', from: 'auto', engine: 'edge' };
      },
      testConnection: async () => {},
    };
    const cached = withCache(provider);

    await expect(cached.translate({ text: 'boom', to: 'zh-CN' })).rejects.toThrow();
    const empty = await cached.translate({ text: 'empty', to: 'zh-CN' });
    const emptyAgain = await cached.translate({ text: 'empty', to: 'zh-CN' });

    expect(empty.text).toBe('');
    expect(emptyAgain.text).toBe('');
    // 错误与空译文都不入缓存：boom 只调 1 次（抛出），empty 调 2 次
    expect(calls.filter((t) => t === 'boom')).toHaveLength(1);
    expect(calls.filter((t) => t === 'empty')).toHaveLength(2);
  });
});

describe('缓存装饰器：二级 storage', () => {
  it('内存清空后仍能从 storage 命中（跨会话有效）', async () => {
    const { provider, calls } = makeProvider();
    await withCache(provider).translate({ text: 'Hello', to: 'zh-CN' });

    clearCache(); // 只清内存层
    const second = await withCache(provider).translate({ text: 'Hello', to: 'zh-CN' });

    expect(calls).toHaveLength(1);
    expect(second.text).toBe('译:Hello');
  });

  it('clearCache({ persistent: true }) 清空两层后重新请求', async () => {
    const { provider, calls } = makeProvider();
    await withCache(provider).translate({ text: 'Hello', to: 'zh-CN' });

    await clearCache({ persistent: true });
    await withCache(provider).translate({ text: 'Hello', to: 'zh-CN' });

    expect(calls).toHaveLength(2);
  });

  it('storage 中损坏的条目被忽略并重新请求', async () => {
    const { provider, calls } = makeProvider();
    const cached = withCache(provider);
    await cached.translate({ text: 'Hello', to: 'zh-CN' });

    // 手动写坏条目
    const all = await browser.storage.local.get(null);
    const key = Object.keys(all).find((k) => k.includes('cache'));
    expect(key).toBeDefined();
    await browser.storage.local.set({ [key as string]: { corrupted: true } });
    clearCache();

    const second = await withCache(provider).translate({ text: 'Hello', to: 'zh-CN' });

    expect(calls).toHaveLength(2);
    expect(second.text).toBe('译:Hello');
  });
});

describe('缓存装饰器：容量与接口', () => {
  it('内存层按 LRU 逐出（关闭 storage 二级时回升为真实请求）', async () => {
    const { provider, calls } = makeProvider();
    const cached = withCache(provider, { maxEntries: 2, persistent: false });

    await cached.translate({ text: 'a', to: 'zh-CN' });
    await cached.translate({ text: 'b', to: 'zh-CN' });
    await cached.translate({ text: 'c', to: 'zh-CN' }); // 逐出 a
    await cached.translate({ text: 'a', to: 'zh-CN' }); // 应重新请求

    expect(calls).toHaveLength(4);
  });

  it('内存层逐出后仍由 storage 层兜住，不重新请求', async () => {
    const { provider, calls } = makeProvider();
    const cached = withCache(provider, { maxEntries: 2 });

    await cached.translate({ text: 'a', to: 'zh-CN' });
    await cached.translate({ text: 'b', to: 'zh-CN' });
    await cached.translate({ text: 'c', to: 'zh-CN' }); // 内存逐出 a，storage 仍在
    await cached.translate({ text: 'a', to: 'zh-CN' }); // storage 命中

    expect(calls).toHaveLength(3);
  });

  it('最近访问的条目不会被优先逐出', async () => {
    const { provider, calls } = makeProvider();
    const cached = withCache(provider, { maxEntries: 2, persistent: false });

    await cached.translate({ text: 'a', to: 'zh-CN' });
    await cached.translate({ text: 'b', to: 'zh-CN' });
    await cached.translate({ text: 'a', to: 'zh-CN' }); // 命中，a 变为最新
    await cached.translate({ text: 'c', to: 'zh-CN' }); // 逐出 b

    expect(calls).toHaveLength(3);

    await cached.translate({ text: 'a', to: 'zh-CN' }); // 仍命中
    expect(calls).toHaveLength(3);
  });

  it('保留 testConnection 与 engine 字段', async () => {
    const { provider } = makeProvider('openai-compatible');
    const cached = withCache(provider);

    expect(cached.engine).toBe('openai-compatible');
    await expect(cached.testConnection()).resolves.toBeUndefined();
  });
});
