/** YouTube json3 响应体结构 */
export interface Json3Segment {
  utf8?: string;
  tOffsetMs?: number;
}

export interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  aAppend?: number;
  segs?: Json3Segment[];
}

export interface Json3Payload {
  events?: Json3Event[];
}

/** 原始字幕条目（毫秒时间轴） */
export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

/** ASR 单词级时间戳（供 T9 subtitle-pipeline 重组为可读句子） */
export interface SubtitleWord {
  startMs: number;
  text: string;
}

export interface ParsedJson3 {
  cues: SubtitleCue[];
  words: SubtitleWord[];
}

export interface FetchJson3Options {
  isAsr: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** 事件缺失 dDurationMs 且无后继事件时的保底显示时长（毫秒） */
const FALLBACK_CUE_DURATION_MS = 2000;

/** 归一化片段文本：换行与连续空白合并为单个空格并去首尾空白 */
function cleanText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** 为字幕轨道 baseUrl 设置 fmt=json3 参数 */
export function buildJson3Url(baseUrl: string): string {
  const url = new URL(baseUrl, 'https://www.youtube.com');
  url.searchParams.set('fmt', 'json3');
  return url.toString();
}

/**
 * 解析 YouTube json3 字幕响应：
 * - cues：过滤纯换行/空白与 aAppend 附加事件后的字幕数组
 * - words：isAsr 为 true 时按 tStartMs + tOffsetMs 展开的单词时间序列
 */
export function parseJson3(payload: Json3Payload, options: { isAsr: boolean }): ParsedJson3 {
  const events = payload.events ?? [];
  const rawCues: Array<{ startMs: number; durationMs?: number; text: string }> = [];
  const words: SubtitleWord[] = [];

  for (const ev of events) {
    if (ev.tStartMs === undefined || !ev.segs || ev.segs.length === 0) continue;
    if (ev.aAppend) continue;

    const combined = cleanText(ev.segs.map((s) => s.utf8 ?? '').join(''));
    if (!combined) continue;

    rawCues.push({
      startMs: ev.tStartMs,
      durationMs: ev.dDurationMs,
      text: combined,
    });

    if (options.isAsr) {
      for (const seg of ev.segs) {
        const token = cleanText(seg.utf8 ?? '');
        if (!token) continue;
        words.push({
          startMs: ev.tStartMs + (seg.tOffsetMs ?? 0),
          text: token,
        });
      }
    }
  }

  const cues: SubtitleCue[] = rawCues.map((item, idx) => {
    const nextStart = rawCues[idx + 1]?.startMs;
    const endMs =
      item.durationMs !== undefined && item.durationMs > 0
        ? item.startMs + item.durationMs
        : nextStart !== undefined && nextStart > item.startMs
          ? nextStart
          : item.startMs + FALLBACK_CUE_DURATION_MS;
    return { startMs: item.startMs, endMs, text: item.text };
  });

  return { cues, words };
}

/** 拉取并解析 json3 字幕轨道 */
export async function fetchJson3Track(
  baseUrl: string,
  options: FetchJson3Options,
): Promise<ParsedJson3> {
  const fetchFn = options.fetchImpl ?? fetch;
  const response = await fetchFn(buildJson3Url(baseUrl), {
    credentials: 'include',
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch json3 track: HTTP ${response.status}`);
  }

  const rawText = await response.text();
  if (!rawText.trim()) {
    throw new Error('Empty json3 track response body');
  }

  const payload = JSON.parse(rawText) as Json3Payload;
  return parseJson3(payload, { isAsr: options.isAsr });
}
