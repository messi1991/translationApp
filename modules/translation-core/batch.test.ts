import { describe, expect, it, vi } from 'vitest';
import { translateBatch } from './batch';
import type { Provider, TranslateInput, TranslateManyInput, TranslationResult } from './provider';

function makeProvider(options: {
  withMany: boolean;
  onTranslate?: (input: TranslateInput) => Promise<TranslationResult>;
  onMany?: (input: TranslateManyInput) => Promise<TranslationResult[]>;
}): Provider {
  const translate = vi.fn(
    options.onTranslate ??
      ((input: TranslateInput) =>
        Promise.resolve({
          text: `译:${input.text}`,
          from: 'auto',
          engine: 'edge' as const,
        })),
  );
  const base: Provider = {
    engine: 'edge',
    translate,
    testConnection: () => Promise.resolve(),
  };
  if (!options.withMany) return base;
  return {
    ...base,
    translateMany: vi.fn(
      options.onMany ??
        ((input: TranslateManyInput) =>
          Promise.resolve(
            input.texts.map((t) => ({ text: `译:${t}`, from: 'auto', engine: 'edge' as const })),
          )),
    ),
  };
}

describe('translateBatch（统一批量入口）', () => {
  it('引擎支持 translateMany 时只调用一次，不逐条翻译', async () => {
    const provider = makeProvider({ withMany: true });

    const results = await translateBatch(provider, { texts: ['a', 'b'], to: 'zh-CN' });

    expect(results.map((r) => r.text)).toEqual(['译:a', '译:b']);
    expect(provider.translateMany).toHaveBeenCalledTimes(1);
    expect(provider.translate).not.toHaveBeenCalled();
  });

  it('引擎不支持批量时逐条串行调用，并保持输入顺序', async () => {
    const order: string[] = [];
    const provider = makeProvider({
      withMany: false,
      onTranslate: async (input) => {
        order.push(input.text);
        return { text: `译:${input.text}`, from: 'auto', engine: 'edge' };
      },
    });

    const results = await translateBatch(provider, { texts: ['a', 'b', 'c'], to: 'zh-CN' });

    expect(order).toEqual(['a', 'b', 'c']);
    expect(results.map((r) => r.text)).toEqual(['译:a', '译:b', '译:c']);
    expect(provider.translate).toHaveBeenCalledTimes(3);
  });

  it('空数组不发请求', async () => {
    const provider = makeProvider({ withMany: true });

    await expect(translateBatch(provider, { texts: [], to: 'zh-CN' })).resolves.toEqual([]);
    expect(provider.translateMany).not.toHaveBeenCalled();
    expect(provider.translate).not.toHaveBeenCalled();
  });
});
