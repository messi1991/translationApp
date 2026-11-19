import type { EngineId } from '@/modules/settings';
import type { TranslateInput } from './provider';

/** 影响译文结果的全部维度；源语言缺省与显式指定视为不同键 */
export interface CacheKeyParts {
  engine: EngineId;
  to: string;
  from: string;
  text: string;
}

/** 归一化文本：首尾空白不影响译文，合并内部连续空白 */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** 由请求构造缓存键参数（from 缺省记作 auto） */
export function keyPartsOf(engine: EngineId, input: TranslateInput): CacheKeyParts {
  return {
    engine,
    to: input.to,
    from: input.from ?? 'auto',
    text: normalizeText(input.text),
  };
}

/** 稳定的字符串键（用于内存 Map）；分隔符用不可见字符避免拼串歧义 */
export function serializeKey(parts: CacheKeyParts): string {
  return [parts.engine, parts.to, parts.from, parts.text].join('\u0000');
}

/**
 * 极简 LRU：Map 保持插入顺序，命中时删除再插入以移到队尾，
 * 超出容量时逐出队首（最久未使用）。
 */
export class Lru<T> {
  private readonly map = new Map<string, T>();

  constructor(private readonly maxEntries: number) {}

  get(key: string): T | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  clear(): void {
    this.map.clear();
  }
}
