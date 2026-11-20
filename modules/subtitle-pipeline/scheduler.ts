import { requestTranslateMany } from '@/modules/translation-core';
import type { PipelineCue } from './regroup';

/** 调度的回看窗口：当前播放位置前 3 秒内未结束的字幕仍需优先翻译 */
export const SCHEDULE_LOOKBEHIND_MS = 3000;
/** 调度的前瞻窗口：距当前播放位置超过 6 分钟的字幕暂不预翻译 */
export const SCHEDULE_HORIZON_MS = 6 * 60_000;
/** 单批最大条数 */
export const SCHEDULE_MAX_BATCH_SIZE = 60;
/** 单批最大累计字符数 */
export const SCHEDULE_MAX_BATCH_CHARS = 5000;
/** 单条字幕前后文上下文最大总字符数 */
export const MAX_CONTEXT_CHARS = 200;
/** 默认最大并发批次数 */
export const DEFAULT_MAX_CONCURRENCY = 2;
/** 批次失败后自动重试前的冷却毫秒数 */
export const FAILED_RETRY_COOLDOWN_MS = 5000;
/** 同一批字幕的最大自动重试次数（用尽后仅在 seek 时重新尝试） */
export const MAX_RETRY_ATTEMPTS = 3;

export interface CueWithContext {
  index: number;
  text: string;
  prev: string[];
  next?: string;
}

export type BatchTranslateResponse =
  | { ok: true; translations: string[] }
  | { ok: false; message: string };

export type BatchTranslateFn = (request: {
  texts: string[];
  contexts: CueWithContext[];
  from?: string;
  to?: string;
}) => Promise<BatchTranslateResponse>;

export interface SubtitleSchedulerOptions {
  cues: readonly PipelineCue[];
  from?: string;
  to?: string;
  maxConcurrency?: number;
  translateBatch?: BatchTranslateFn;
  onUpdate?: (translatedIndices: number[]) => void;
  onError?: (message: string) => void;
}

export interface SubtitleScheduler {
  updateTime: (timeMs: number) => void;
  seek: (timeMs: number) => void;
  getTranslation: (cueIndex: number) => string | undefined;
  destroy: () => void;
}

/**
 * 围绕播放时间 currentTimeMs 规划下一批待翻译的连续字幕下标。
 *
 * @param cues 按时间升序排列的字幕数组
 * @param claimed 每条是否已发出请求或已完成翻译
 * @param currentTimeMs 当前播放进度（毫秒）
 */
export function planNextBatch(
  cues: readonly PipelineCue[],
  claimed: readonly boolean[],
  currentTimeMs: number,
): number[] | null {
  const minEnd = currentTimeMs - SCHEDULE_LOOKBEHIND_MS;
  const maxStart = currentTimeMs + SCHEDULE_HORIZON_MS;

  let i = cues.findIndex((c) => c.endMs > minEnd);
  if (i < 0) return null;

  while (i < cues.length && claimed[i]) {
    i += 1;
  }
  const firstCue = cues[i];
  if (!firstCue || firstCue.startMs > maxStart) {
    return null;
  }

  const batch: number[] = [];
  let chars = 0;

  for (; i < cues.length && batch.length < SCHEDULE_MAX_BATCH_SIZE && !claimed[i]; i += 1) {
    const cue = cues[i]!;
    if (cue.startMs > maxStart) break;
    if (batch.length > 0 && chars + cue.text.length > SCHEDULE_MAX_BATCH_CHARS) break;
    batch.push(i);
    chars += cue.text.length;
  }

  return batch.length > 0 ? batch : null;
}

function truncateText(text: string, maxLen: number): string {
  if (maxLen <= 0) return '';
  return text.length <= maxLen ? text : text.slice(0, maxLen);
}

/**
 * 为批次中的每条字幕抽取前 2 条 + 后 1 条上下文，并将单条附带上下文总长限制在 200 字符内。
 */
export function buildCueContexts(
  cues: readonly PipelineCue[],
  indices: readonly number[],
): CueWithContext[] {
  return indices.map((index) => {
    const current = cues[index];
    const text = current?.text ?? '';
    let budget = MAX_CONTEXT_CHARS;

    // 优先保证紧邻的上一条（i-1）和下一条（i+1），剩余预算再分配给 i-2
    const prev1Raw = index >= 1 ? cues[index - 1]?.text ?? '' : '';
    const nextRaw = index + 1 < cues.length ? cues[index + 1]?.text ?? '' : '';
    const prev2Raw = index >= 2 ? cues[index - 2]?.text ?? '' : '';

    const prev1 = truncateText(prev1Raw, Math.min(prev1Raw.length, Math.floor(budget * 0.5)));
    budget -= prev1.length;

    const next = truncateText(nextRaw, Math.min(nextRaw.length, Math.max(0, budget - 1)));
    if (next) budget -= next.length + (prev1 ? 1 : 0);

    const prev2 = truncateText(prev2Raw, Math.max(0, budget - 1));

    const prev: string[] = [];
    if (prev2) prev.push(prev2);
    if (prev1) prev.push(prev1);

    return {
      index,
      text,
      prev,
      ...(next ? { next } : {}),
    };
  });
}

const defaultBatchTranslate: BatchTranslateFn = async ({ texts, from, to }) => {
  const res = await requestTranslateMany({ texts, from, to });
  if (!res.ok) {
    return { ok: false, message: res.message };
  }
  return {
    ok: true,
    translations: res.result.map((r) => r.text),
  };
};

/**
 * 创建位置感知字幕预翻译调度器：
 * - 维护已翻译表、进行中集合与失败冷却（5s）重试标记
 * - 支持最多 maxConcurrency（默认 2）个批次并发
 * - seek 时清空冷却与失败次数并立即围绕新时间窗口调度
 */
export function createSubtitleScheduler(options: SubtitleSchedulerOptions): SubtitleScheduler {
  const { cues, from, to, onUpdate, onError } = options;
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const translateBatch = options.translateBatch ?? defaultBatchTranslate;

  const translations = new Array<string | undefined>(cues.length);
  const inflight = new Array<boolean>(cues.length).fill(false);
  // 失败冷却结束时间戳（毫秒），0 表示可立即请求
  const retryAt = new Array<number>(cues.length).fill(0);
  const failedAttempts = new Array<number>(cues.length).fill(0);
  // 自动重试用尽的条目，仅在 seek 时复活
  const abandoned = new Array<boolean>(cues.length).fill(false);

  let currentTimeMs = 0;
  let activeJobs = 0;
  let destroyed = false;

  const isClaimed = (): boolean[] => {
    const now = Date.now();
    return cues.map(
      (_, idx) =>
        translations[idx] !== undefined ||
        inflight[idx] ||
        abandoned[idx] ||
        retryAt[idx]! > now,
    );
  };

  const pump = () => {
    if (destroyed) return;
    while (activeJobs < maxConcurrency) {
      const batch = planNextBatch(cues, isClaimed(), currentTimeMs);
      if (!batch) break;

      for (const idx of batch) {
        inflight[idx] = true;
      }
      activeJobs += 1;
      void runBatch(batch);
    }
  };

  /** 批次失败：累计失败次数，未用尽则进入冷却等待自动重试，用尽则等 seek */
  const markFailed = (batch: readonly number[]) => {
    const now = Date.now();
    for (const cueIdx of batch) {
      inflight[cueIdx] = false;
      failedAttempts[cueIdx] = (failedAttempts[cueIdx] ?? 0) + 1;
      if (failedAttempts[cueIdx]! >= MAX_RETRY_ATTEMPTS) {
        abandoned[cueIdx] = true;
        retryAt[cueIdx] = 0;
      } else {
        retryAt[cueIdx] = now + FAILED_RETRY_COOLDOWN_MS;
      }
    }
  };

  const runBatch = async (batch: number[]) => {
    const texts = batch.map((idx) => cues[idx]!.text);
    const contexts = buildCueContexts(cues, batch);

    try {
      const res = await translateBatch({ texts, contexts, from, to });
      if (destroyed) return;

      if (res.ok && res.translations.length === batch.length) {
        for (let k = 0; k < batch.length; k += 1) {
          const cueIdx = batch[k]!;
          inflight[cueIdx] = false;
          failedAttempts[cueIdx] = 0;
          retryAt[cueIdx] = 0;
          abandoned[cueIdx] = false;
          translations[cueIdx] = res.translations[k] ?? '';
        }
        onUpdate?.(batch);
      } else {
        markFailed(batch);
        onError?.(res.ok ? '批量翻译返回条数不匹配' : res.message);
      }
    } catch (err) {
      if (destroyed) return;
      markFailed(batch);
      onError?.(err instanceof Error ? err.message : '字幕批量翻译异常');
    } finally {
      activeJobs -= 1;
      if (!destroyed) {
        pump();
      }
    }
  };

  return {
    updateTime(timeMs: number) {
      if (destroyed) return;
      currentTimeMs = Math.max(0, timeMs);
      pump();
    },

    seek(timeMs: number) {
      if (destroyed) return;
      currentTimeMs = Math.max(0, timeMs);
      // seek 时清空冷却与失败计数，让失败过的区段在用户主动跳回时能够重新请求
      retryAt.fill(0);
      failedAttempts.fill(0);
      abandoned.fill(false);
      pump();
    },

    getTranslation(cueIndex: number): string | undefined {
      return translations[cueIndex];
    },

    destroy() {
      destroyed = true;
    },
  };
}
