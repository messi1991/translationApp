import { browser } from 'wxt/browser';
import type { Provider, TranslateInput, TranslationResult } from './provider';
import { Lru, keyPartsOf, serializeKey } from './cache-key';

/** storage 层键前缀（wxt storage 的 local: 约定） */
const STORAGE_KEY = 'local:translation-cache';

/** storage 中缓存的整体形态：键 → 结果 */
type CacheRecord = Record<string, TranslationResult>;

export interface CacheOptions {
  /** 内存层最大条目数 */
  maxEntries?: number;
  /** 是否启用 storage 二级缓存（默认启用） */
  persistent?: boolean;
  /** storage 层最大条目数，超出时按写入顺序逐出最旧 */
  maxPersistentEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_PERSISTENT = 500;

/** 共享内存层：所有装饰器实例复用，便于全局清理 */
const memory = new Lru<TranslationResult>(DEFAULT_MAX_ENTRIES);

/** 结果是否值得缓存：空译文无价值，错误不缓存（由调用方抛出） */
function isCacheable(result: TranslationResult): boolean {
  return typeof result.text === 'string' && result.text.length > 0;
}

/** 读取 storage 层，损坏或结构异常一律视为空缓存 */
async function readPersistent(): Promise<CacheRecord> {
  try {
    const raw = await browser.storage.local.get(STORAGE_KEY);
    const value = raw[STORAGE_KEY];
    if (!value || typeof value !== 'object') return {};
    return value as CacheRecord;
  } catch {
    return {};
  }
}

/** 写入 storage 层，并裁剪到上限（保留最近写入的条目） */
async function writePersistent(record: CacheRecord, limit: number): Promise<void> {
  const entries = Object.entries(record);
  const trimmed: CacheRecord =
    entries.length > limit ? Object.fromEntries(entries.slice(-limit)) : record;
  try {
    await browser.storage.local.set({ [STORAGE_KEY]: trimmed });
  } catch {
    /* 缓存写入失败不影响翻译流程 */
  }
}

/** 清空缓存：默认只清内存层，persistent 时连同 storage 一并清除 */
export async function clearCache(options: { persistent?: boolean } = {}): Promise<void> {
  memory.clear();
  if (options.persistent) {
    await browser.storage.local.remove(STORAGE_KEY);
  }
}

/**
 * 给引擎套上二级缓存：先查内存，再查 storage，都未命中才调用引擎。
 * 键由引擎 + 目标语言 + 源语言 + 归一化文本构成，任一不同即视为不同条目。
 */
export function withCache(provider: Provider, options: CacheOptions = {}): Provider {
  const {
    maxEntries = DEFAULT_MAX_ENTRIES,
    persistent = true,
    maxPersistentEntries = DEFAULT_MAX_PERSISTENT,
  } = options;

  const local = new Lru<TranslationResult>(maxEntries);

  const lookup = async (key: string): Promise<TranslationResult | undefined> => {
    const hit = local.get(key);
    if (hit) return hit;
    if (!persistent) return undefined;

    const record = await readPersistent();
    const stored = record[key];
    if (!stored || typeof stored.text !== 'string' || !stored.text) return undefined;
    local.set(key, stored);
    return stored;
  };

  const store = async (key: string, result: TranslationResult): Promise<void> => {
    local.set(key, result);
    if (!persistent) return;

    const record = await readPersistent();
    record[key] = result;
    await writePersistent(record, maxPersistentEntries);
  };

  const translate = async (input: TranslateInput): Promise<TranslationResult> => {
    const text = input.text.trim();
    if (!text) return provider.translate(input);

    const key = serializeKey(keyPartsOf(provider.engine, input));
    const cached = await lookup(key);
    if (cached) return cached;

    const result = await provider.translate(input);
    if (isCacheable(result)) await store(key, result);
    return result;
  };

  return {
    engine: provider.engine,
    translate,
    testConnection: () => provider.testConnection(),
    ...(provider.translateMany
      ? { translateMany: (input) => provider.translateMany!(input) }
      : {}),
  };
}
