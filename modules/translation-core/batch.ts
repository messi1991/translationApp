import type { Provider, TranslateManyInput, TranslationResult } from './provider';

/**
 * 统一批量翻译：引擎支持 translateMany 时合并为一次请求，
 * 否则逐条调用 translate 并保持顺序（串行，避免触发限流）。
 */
export async function translateBatch(
  provider: Provider,
  input: TranslateManyInput,
): Promise<TranslationResult[]> {
  if (input.texts.length === 0) return [];

  if (provider.translateMany) {
    return provider.translateMany(input);
  }

  const results: TranslationResult[] = [];
  for (const text of input.texts) {
    results.push(
      await provider.translate({ text, to: input.to, from: input.from }),
    );
  }
  return results;
}
