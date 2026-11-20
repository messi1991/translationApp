import { TranslationError } from './error';
import type { Provider, TranslateInput, TranslateManyInput, TranslationResult } from './provider';

export const DEFAULT_RATE_LIMIT_RETRIES = 2;
export const DEFAULT_BACKOFF_BASE_MS = 300;
export const DEFAULT_BACKOFF_MAX_MS = 3000;
export const DEFAULT_ENGINE_CONCURRENCY = 3;
export const DEFAULT_ENGINE_QUEUE_SIZE = 60;

export interface RateLimitOptions {
  /** 遇到 429 (rate-limit) 时的最大重试次数（不含首次调用），默认 2 */
  maxRetries?: number;
  /** 指数退避起始毫秒数，默认 300ms */
  baseDelayMs?: number;
  /** 单次退避等待毫秒数上限，默认 3000ms */
  maxDelayMs?: number;
  /** 随机正向抖动比例（0 ~ 0.3），默认 0 */
  jitterRatio?: number;
  /** 同时在途的网络请求上限，默认 3 */
  maxConcurrency?: number;
  /** 等待队列最大长度，超出时直接报 rate-limit 防止积压雪崩，默认 60 */
  maxQueueSize?: number;
  /** 自定义睡眠函数（测试注入） */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestQueue {
  run: <T>(task: () => Promise<T>) => Promise<T>;
  reset: () => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 计算第 attempt 次（0 起算）重试的指数退避毫秒数：
 * min(maxDelayMs, baseDelayMs * 2^attempt + jitter)，严格不超过 maxDelayMs。
 */
export function computeBackoffMs(
  attempt: number,
  baseDelayMs = DEFAULT_BACKOFF_BASE_MS,
  maxDelayMs = DEFAULT_BACKOFF_MAX_MS,
  jitterRatio = 0,
): number {
  const exp = baseDelayMs * Math.pow(2, Math.max(0, attempt));
  const capped = Math.min(maxDelayMs, exp);
  if (jitterRatio <= 0) {
    return Math.round(capped);
  }
  const jitter = capped * jitterRatio * Math.random();
  return Math.min(maxDelayMs, Math.round(capped + jitter));
}

/** 创建带并发上限与有界等待队列的执行器 */
export function createRequestQueue(
  maxConcurrency = DEFAULT_ENGINE_CONCURRENCY,
  maxQueueSize = DEFAULT_ENGINE_QUEUE_SIZE,
): RequestQueue {
  let active = 0;
  const waiting: Array<() => void> = [];

  const pump = () => {
    while (active < maxConcurrency && waiting.length > 0) {
      const wake = waiting.shift()!;
      active += 1;
      wake();
    }
  };

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const execute = () => {
          task().then(
            (val) => {
              active -= 1;
              pump();
              resolve(val);
            },
            (err: unknown) => {
              active -= 1;
              pump();
              reject(err);
            },
          );
        };

        if (active < maxConcurrency) {
          active += 1;
          execute();
          return;
        }

        if (waiting.length >= maxQueueSize) {
          reject(new TranslationError('rate-limit', '排队请求过多，请稍后再试'));
          return;
        }

        waiting.push(execute);
      });
    },
    reset() {
      waiting.length = 0;
    },
  };
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof TranslationError && err.code === 'rate-limit';
}

/**
 * 为引擎装饰统一的并发队列与 HTTP 429 指数退避重试能力：
 * - 所有 translate / translateMany 请求经过同一有界并发队列，防止划词与字幕同时突发打爆接口
 * - 遇到 rate-limit 错误时按 baseDelayMs * 2^attempt（不超过 maxDelayMs）自动退避重试
 * - 非 429 错误（如鉴权失败、语言不支持）立即透传
 */
export function withRateLimit(
  provider: Provider,
  options: RateLimitOptions = {},
  sharedQueue?: RequestQueue,
): Provider {
  const {
    maxRetries = DEFAULT_RATE_LIMIT_RETRIES,
    baseDelayMs = DEFAULT_BACKOFF_BASE_MS,
    maxDelayMs = DEFAULT_BACKOFF_MAX_MS,
    jitterRatio = 0,
    maxConcurrency = DEFAULT_ENGINE_CONCURRENCY,
    maxQueueSize = DEFAULT_ENGINE_QUEUE_SIZE,
    sleep = defaultSleep,
  } = options;

  const queue = sharedQueue ?? createRequestQueue(maxConcurrency, maxQueueSize);

  const executeWithBackoff = async <T>(fn: () => Promise<T>): Promise<T> => {
    let attempt = 0;
    while (true) {
      try {
        return await queue.run(fn);
      } catch (err) {
        if (!isRateLimitError(err) || attempt >= maxRetries) {
          throw err;
        }
        const waitMs = computeBackoffMs(attempt, baseDelayMs, maxDelayMs, jitterRatio);
        attempt += 1;
        await sleep(waitMs);
      }
    }
  };

  return {
    engine: provider.engine,
    translate(input: TranslateInput): Promise<TranslationResult> {
      return executeWithBackoff(() => provider.translate(input));
    },
    ...(provider.translateMany
      ? {
          translateMany(input: TranslateManyInput): Promise<TranslationResult[]> {
            return executeWithBackoff(() => provider.translateMany!(input));
          },
        }
      : {}),
    // 连通性测试直通一次探针，避免配置调试时让用户在按钮上干等重试
    testConnection(): Promise<void> {
      return queue.run(() => provider.testConnection());
    },
  };
}
