import { describe, expect, it, vi } from 'vitest';
import type { PipelineCue } from './regroup';
import {
  buildCueContexts,
  createSubtitleScheduler,
  MAX_RETRY_ATTEMPTS,
  planNextBatch,
  SCHEDULE_HORIZON_MS,
  SCHEDULE_LOOKBEHIND_MS,
  SCHEDULE_MAX_BATCH_SIZE,
} from './scheduler';

function makeCues(count: number, stepMs = 4000, textFn = (i: number) => `Line ${i}`): PipelineCue[] {
  return Array.from({ length: count }, (_, i) => ({
    startMs: i * stepMs,
    endMs: i * stepMs + 3000,
    text: textFn(i),
  }));
}

describe('planNextBatch（位置感知批计划）', () => {
  it('从 currentTime - 3s 之后结束的首条未翻条目开始，最多取 60 条且不越过 6 分钟 horizon', () => {
    // 每条间隔 10s，100 条覆盖 0 ~ 1000s（16.6 分钟）
    const cues = makeCues(100, 10_000);
    const settled = new Array<boolean>(100).fill(false);
    // 假设前 3 条（0s, 10s, 20s）已翻译
    settled[0] = true;
    settled[1] = true;
    settled[2] = true;

    // 当前播放时间 22_000ms，lookbehind 3s = 19_000ms；
    // cue[1] endMs=13_000 <= 19_000；cue[2] endMs=23_000 > 19_000 但已翻 -> 跳过到 cue[3] (start=30_000)
    // horizon 上界 = 22_000 + 360_000 = 382_000ms -> cue[38] start=380_000 在界内，cue[39] start=390_000 超出
    const batch = planNextBatch(cues, settled, 22_000);
    expect(batch).not.toBeNull();
    expect(batch![0]).toBe(3);
    expect(batch!.at(-1)).toBe(38);
    expect(batch!.every((idx) => !settled[idx])).toBe(true);
    for (const idx of batch!) {
      expect(cues[idx]!.startMs).toBeLessThanOrEqual(22_000 + SCHEDULE_HORIZON_MS);
      expect(cues[idx]!.endMs).toBeGreaterThan(22_000 - SCHEDULE_LOOKBEHIND_MS);
    }
  });

  it('单批条数不超过 60 条，总字符数不超过 5000，遇到中间已翻译条目即截断保持连续上下文', () => {
    const cues = makeCues(80, 1000);
    const settled = new Array<boolean>(80).fill(false);
    const fullBatch = planNextBatch(cues, settled, 0);
    expect(fullBatch).toHaveLength(SCHEDULE_MAX_BATCH_SIZE);

    // 若第 5 条已翻译，第一批只取 [0..4]
    settled[5] = true;
    expect(planNextBatch(cues, settled, 0)).toEqual([0, 1, 2, 3, 4]);

    // 单条 1500 字符时，5000 字符上限最多装 3 条
    const longCues = makeCues(10, 1000, (i) => `${i}:` + 'a'.repeat(1500));
    expect(planNextBatch(longCues, new Array<boolean>(10).fill(false), 0)).toEqual([0, 1, 2]);
  });

  it('首条未翻字幕起点超出当前时间 + 6 分钟时返回 null（不浪费额度提前翻整部视频）', () => {
    const cues = makeCues(60, 10_000);
    const settled = new Array<boolean>(60).fill(false);
    // 0 ~ 370s（0..37）全部已翻，下一条 cue[38] start=380_000 > 0 + 360_000
    for (let i = 0; i <= 37; i++) settled[i] = true;
    expect(planNextBatch(cues, settled, 0)).toBeNull();
  });
});

describe('buildCueContexts（前后文上下文构造）', () => {
  it('提取前 2 条与后 1 条邻近字幕，总长裁剪在 200 字符以内', () => {
    const cues = makeCues(5, 2000, (i) => `Sentence number ${i}.`);
    const ctx = buildCueContexts(cues, [2]);
    expect(ctx).toEqual([
      {
        index: 2,
        text: 'Sentence number 2.',
        prev: ['Sentence number 0.', 'Sentence number 1.'],
        next: 'Sentence number 3.',
      },
    ]);

    const hugeCues = makeCues(4, 2000, (i) => `${i}-` + 'x'.repeat(150));
    const trimmed = buildCueContexts(hugeCues, [2])[0]!;
    const totalContextLen = trimmed.prev.join(' ').length + (trimmed.next?.length ?? 0);
    expect(totalContextLen).toBeLessThanOrEqual(200);
  });
});

describe('createSubtitleScheduler（并发上限 + seek 重算 + 缓存去重）', () => {
  it('最多并发 2 个批次；seek 到远处时新批次立即围绕新时间点规划，且已完成条目不重复请求', async () => {
    // 100 条字幕，每条间隔 10s（总长 1000s）
    const cues = makeCues(100, 10_000);
    const pendingJobs: Array<{
      texts: string[];
      resolve: (translations: string[]) => void;
    }> = [];

    const translateBatchFn = vi.fn((req: { texts: string[] }) => {
      return new Promise<{ ok: true; translations: string[] }>((resolve) => {
        pendingJobs.push({
          texts: req.texts,
          resolve: (translations) => resolve({ ok: true, translations }),
        });
      });
    });

    const updatedIndices: number[][] = [];
    const scheduler = createSubtitleScheduler({
      cues,
      maxConcurrency: 2,
      translateBatch: translateBatchFn,
      onUpdate: (indices) => updatedIndices.push(indices),
    });

    // t = 0 启动：horizon=360s 覆盖 0..36（共 37 条 < 60），只产生 1 个批次
    scheduler.updateTime(0);
    expect(pendingJobs).toHaveLength(1);
    expect(pendingJobs[0]!.texts[0]).toBe('Line 0');
    expect(pendingJobs[0]!.texts).toHaveLength(37);

    // 用户突然 seek 到 700s（700_000ms）：立刻规划第 2 个并发批次，起点应为 700s 附近（cue[70]）
    scheduler.seek(700_000);
    expect(pendingJobs).toHaveLength(2);
    expect(pendingJobs[1]!.texts[0]).toBe('Line 70');

    // 完成第 2 个批次（70..99）
    pendingJobs[1]!.resolve(pendingJobs[1]!.texts.map((t) => `ZH:${t}`));
    await vi.waitFor(() => {
      expect(scheduler.getTranslation(70)).toBe('ZH:Line 70');
      expect(scheduler.getTranslation(99)).toBe('ZH:Line 99');
    });
    expect(updatedIndices.length).toBeGreaterThanOrEqual(1);

    // 再次在 700s tick，70..99 已完成且无新未翻条目在 [697s, 1060s] 内 -> 不再发新请求
    const callsBefore = translateBatchFn.mock.calls.length;
    scheduler.updateTime(705_000);
    expect(translateBatchFn.mock.calls.length).toBe(callsBefore);

    scheduler.destroy();
  });

  it('批次翻译失败时释放占用标记，允许后续播放推进或 seek 重试，不永久卡死', async () => {
    const cues = makeCues(5, 2000);
    let attempt = 0;
    const translateBatchFn = vi.fn(async (req: { texts: string[] }) => {
      attempt += 1;
      if (attempt === 1) {
        return { ok: false as const, message: 'network error' };
      }
      return { ok: true as const, translations: req.texts.map((t) => `译:${t}`) };
    });

    const scheduler = createSubtitleScheduler({
      cues,
      translateBatch: translateBatchFn,
    });

    scheduler.updateTime(0);
    await vi.waitFor(() => {
      expect(translateBatchFn).toHaveBeenCalledTimes(1);
    });

    // 第一次失败后，用户 seek 或下一次重试应能再次拉起翻译
    scheduler.seek(0);
    await vi.waitFor(() => {
      expect(scheduler.getTranslation(0)).toBe('译:Line 0');
    });

    scheduler.destroy();
  });

  it('批次失败后冷却到期自动重试，无需用户 seek', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const cues = makeCues(5, 2000);
    let attempt = 0;
    const translateBatchFn = vi.fn(async (req: { texts: string[] }) => {
      attempt += 1;
      if (attempt === 1) {
        return { ok: false as const, message: 'network error' };
      }
      return { ok: true as const, translations: req.texts.map((t) => `译:${t}`) };
    });

    const scheduler = createSubtitleScheduler({ cues, translateBatch: translateBatchFn });

    try {
      scheduler.updateTime(0);
      await vi.waitFor(() => {
        expect(translateBatchFn).toHaveBeenCalledTimes(1);
      });

      // 冷却未到期：播放继续推进也不会重发请求
      vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
      scheduler.updateTime(2000);
      await Promise.resolve();
      expect(translateBatchFn).toHaveBeenCalledTimes(1);

      // 冷却 5s 到期：下一帧自动重试并拿到译文
      vi.setSystemTime(new Date('2026-01-01T00:00:06Z'));
      scheduler.updateTime(3000);
      await vi.waitFor(() => {
        expect(scheduler.getTranslation(0)).toBe('译:Line 0');
      });
      expect(translateBatchFn).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.destroy();
      vi.useRealTimers();
    }
  });

  it('同一批自动重试用尽后不再重发，seek 才重新拉起', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const cues = makeCues(3, 2000);
    const translateBatchFn = vi.fn(async () => ({ ok: false as const, message: 'network error' }));
    const errors: string[] = [];

    const scheduler = createSubtitleScheduler({
      cues,
      translateBatch: translateBatchFn,
      onError: (message) => errors.push(message),
    });

    try {
      for (let i = 0; i < MAX_RETRY_ATTEMPTS; i += 1) {
        vi.setSystemTime(new Date(`2026-01-01T00:00:0${i * 6}Z`));
        scheduler.updateTime(0);
        await vi.waitFor(() => {
          expect(translateBatchFn).toHaveBeenCalledTimes(i + 1);
        });
      }
      expect(errors).toEqual(Array<string>(MAX_RETRY_ATTEMPTS).fill('network error'));

      // 重试用尽：时间再推进也不发请求
      vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
      scheduler.updateTime(3000);
      await Promise.resolve();
      expect(translateBatchFn).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS);

      // seek 清空失败计数，立即重新请求
      scheduler.seek(0);
      await vi.waitFor(() => {
        expect(translateBatchFn).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS + 1);
      });
    } finally {
      scheduler.destroy();
      vi.useRealTimers();
    }
  });
});
