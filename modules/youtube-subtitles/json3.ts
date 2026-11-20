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

/** 去掉 query 里的 fmt 参数，其余参数（含签名）保持原始字节不变 */
function stripFmtParam(url: string): string {
  const queryIndex = url.indexOf('?');
  if (queryIndex < 0) return url;
  const kept = url
    .slice(queryIndex + 1)
    .split('&')
    .filter((pair) => pair.length > 0 && !pair.startsWith('fmt='));
  const path = url.slice(0, queryIndex);
  return kept.length > 0 ? `${path}?${kept.join('&')}` : path;
}

/**
 * 为字幕轨道 baseUrl 追加 `fmt=json3`。
 *
 * 必须用字符串拼接而非 `URL` / `URLSearchParams` 改写 query：后者会把 `signature` 等参数
 * 重新编码，YouTube 校验不过时返回 HTTP 200 + 空 body（表现为字幕永远只有原文）。
 */
export function buildJson3Url(baseUrl: string): string {
  const stripped = stripFmtParam(baseUrl);
  const separator = stripped.includes('?') ? '&' : '?';
  return `${stripped}${separator}fmt=json3`;
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
  const res = await requestSubtitleText(buildJson3Url(baseUrl), options);
  if (!res.ok) {
    throw new Error(`Failed to fetch json3 track: HTTP ${res.status}`);
  }
  const parsed = parseSubtitleBody(res.text, { isAsr: options.isAsr });
  if (!parsed) {
    throw new Error(
      `Empty json3 track response body (HTTP ${res.status}, ${res.text.length} bytes)`,
    );
  }
  return parsed;
}

/** 原始字幕响应体（不解析格式），供上层按降级顺序重试 */
export interface SubtitleTextResponse {
  ok: boolean;
  status: number;
  text: string;
}

/** 请求任意字幕 URL，返回状态与原始文本（不抛异常，由调用方判定） */
export async function requestSubtitleText(
  url: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<SubtitleTextResponse> {
  const fetchFn = options.fetchImpl ?? fetch;
  const response = await fetchFn(url, { credentials: 'include', signal: options.signal });
  const text = await response.text().catch(() => '');
  return { ok: response.ok, status: response.status, text };
}

/**
 * 解析 srv1（`<text start dur>`）与 srv3（`<p t d><s t>`）字幕 XML。
 * WEB 客户端的签名 URL 偶尔对 json3 返回空体，但同一 URL 的 XML 格式仍可用。
 */
export function parseTranscriptXml(xmlText: string): ParsedJson3 {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const cues: SubtitleCue[] = [];
  const words: SubtitleWord[] = [];

  for (const node of Array.from(doc.querySelectorAll('text'))) {
    const startSec = Number(node.getAttribute('start'));
    if (!Number.isFinite(startSec)) continue;
    const text = cleanText(node.textContent ?? '');
    if (!text) continue;
    const durSec = Number(node.getAttribute('dur'));
    const startMs = Math.round(startSec * 1000);
    cues.push({
      startMs,
      endMs:
        Number.isFinite(durSec) && durSec > 0
          ? startMs + Math.round(durSec * 1000)
          : startMs + FALLBACK_CUE_DURATION_MS,
      text,
    });
  }

  if (cues.length === 0) {
    for (const p of Array.from(doc.querySelectorAll('p'))) {
      const startMs = Number(p.getAttribute('t'));
      if (!Number.isFinite(startMs)) continue;
      const text = cleanText(p.textContent ?? '');
      if (!text) continue;
      const durMs = Number(p.getAttribute('d'));
      cues.push({
        startMs,
        endMs:
          Number.isFinite(durMs) && durMs > 0 ? startMs + durMs : startMs + FALLBACK_CUE_DURATION_MS,
        text,
      });
      for (const s of Array.from(p.querySelectorAll('s'))) {
        const token = cleanText(s.textContent ?? '');
        if (!token) continue;
        const offset = Number(s.getAttribute('t') ?? 0);
        words.push({ startMs: startMs + (Number.isFinite(offset) ? offset : 0), text: token });
      }
    }
  }

  return { cues, words };
}

/** 按内容判别字幕响应体格式（JSON / XML），无法解析或无字幕条目时返回 null */
export function parseSubtitleBody(text: string, options: { isAsr: boolean }): ParsedJson3 | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('<')) {
    const parsed = parseTranscriptXml(trimmed);
    return parsed.cues.length > 0 ? parsed : null;
  }

  try {
    const parsed = parseJson3(JSON.parse(trimmed) as Json3Payload, { isAsr: options.isAsr });
    return parsed.cues.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}
