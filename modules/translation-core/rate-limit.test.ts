import { describe, expect, it, vi } from 'vitest';
import { TranslationError } from './error';
import type { Provider } from './provider';
import { computeBackoffMs, withRateLimit } from './rate-limit';

describe('computeBackoffMs（指数退避间隔计算）', () => {
  it('按 baseDelayMs * 2^attempt 递增，且严格不超过 maxDelayMs 上限', () => {
    expect(computeBackoffMs(0, 400, 3000)).toBe(400);
    expect(computeBackoffMs(1, 400, 3000)).toBe(800);
    expect(computeBackoffMs(2, 400, 3000)).toBe(1600);
    expect(computeBackoffMs(3, 400, 3000)).toBe(3000);
    expect(computeBackoffMs(8, 400, 3000)).toBe(3000);
  });
});

describe('withRateLimit（429 指数退避、并发上限与请求队列）', () => {
  it('连续 429 时重试间隔递增且不超过上限，中途恢复 200 则返回译文，超出最大重试次数则抛出 rate-limit', async () => {
    const slept: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      slept.push(ms);
    });

    // 场景 A：前 3 次 429，第 4 次成功
    let callsA = 0;
    const rawA: Provider = {
      engine: 'edge',
      async translate(input) {
        callsA += 1;
        if (callsA <= 3) {
          throw new TranslationError('rate-limit', 'HTTP 429');
        }
        return { text: '译:' + input.text, from: 'en', engine: 'edge' };
      },
      async testConnection() {},
    };

    const guardedA = withRateLimit(rawA, {
      maxRetries: 4,
      baseDelayMs: 300,
      maxDelayMs: 1000,
      jitterRatio: 0,
      sleep,
    });

    const resA = await guardedA.translate({ text: 'Hello', to: 'zh-CN' });
    expect(resA.text).toBe('译:Hello');
    // 间隔递增：300 -> 600 -> 1000（被上限 1000 截断，而非 1200）
    expect(slept).toEqual([300, 600, 1000]);

    // 场景 B：持续 429 直至耗尽 maxRetries
    slept.length = 0;
    const rawB: Provider = {
      engine: 'edge',
      async translate() {
        throw new TranslationError('rate-limit', 'HTTP 429');
      },
      async testConnection() {},
    };
    const guardedB = withRateLimit(rawB, {
      maxRetries: 3,
      baseDelayMs: 200,
      maxDelayMs: 500,
      jitterRatio: 0,
      sleep,
    });

    await expect(guardedB.translate({ text: 'Fail', to: 'zh-CN' })).rejects.toMatchObject({
      code: 'rate-limit',
    });
    expect(slept).toEqual([200, 400, 500]);
  });

  it('非 429 错误（如 authentication / unsupported-language）立即透传不盲目重试', async () => {
    const sleep = vi.fn(async () => {});
    const translate = vi.fn(async () => {
      throw new TranslationError('authentication', 'invalid key');
    });
    const guarded = withRateLimit(
      { engine: 'openai-compatible', translate, testConnection: async () => {} },
      { maxRetries: 3, sleep },
    );

    await expect(guarded.translate({ text: 'Hi', to: 'zh-CN' })).rejects.toMatchObject({
      code: 'authentication',
    });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('并发上限与请求队列：同时发起 6 个请求时在途数永不超过 maxConcurrency，全部按序完成；队列满时拒绝溢出请求', async () => {
    let inflight = 0;
    let peakInflight = 0;
    const resolvers: Array<() => void> = [];

    const raw: Provider = {
      engine: 'openai-compatible',
      translate(input) {
        inflight += 1;
        peakInflight = Math.max(peakInflight, inflight);
        return new Promise((resolve) => {
          resolvers.push(() => {
            inflight -= 1;
            resolve({ text: 'ok:' + input.text, from: 'en', engine: 'openai-compatible' });
          });
        });
      },
      async testConnection() {},
    };

    const guarded = withRateLimit(raw, {
      maxConcurrency: 2,
      maxQueueSize: 3,
      maxRetries: 0,
    });

    // 2 个立即执行 + 3 个进入等待队列 = 5 个受控请求；第 6 个超出队列上限立即报 rate-limit
    const p1 = guarded.translate({ text: '1', to: 'zh-CN' });
    const p2 = guarded.translate({ text: '2', to: 'zh-CN' });
    const p3 = guarded.translate({ text: '3', to: 'zh-CN' });
    const p4 = guarded.translate({ text: '4', to: 'zh-CN' });
    const p5 = guarded.translate({ text: '5', to: 'zh-CN' });
    const p6 = guarded.translate({ text: '6', to: 'zh-CN' });

    await expect(p6).rejects.toMatchObject({ code: 'rate-limit' });
    expect(peakInflight).toBe(2);

    // 逐批放行在途任务，队列任务依次补位且峰值并发始终 <= 2
    while (resolvers.length > 0) {
      const next = resolvers.shift()!;
      next();
      await Promise.resolve();
      await Promise.resolve();
    }

    const settled = await Promise.all([p1, p2, p3, p4, p5]);
    expect(settled.map((r) => r.text)).toEqual(['ok:1', 'ok:2', 'ok:3', 'ok:4', 'ok:5']);
    expect(peakInflight).toBe(2);
  });
});
