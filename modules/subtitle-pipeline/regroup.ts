/** 平台无关字幕单词（ASR 词级输入） */
export interface PipelineWord {
  startMs: number;
  text: string;
}

/** 平台无关字幕条目（毫秒时间轴） */
export interface PipelineCue {
  startMs: number;
  endMs: number;
  text: string;
}

const MAX_DISPLAY_WIDTH = 84;
const CLAUSE_BREAK_WIDTH = Math.ceil(MAX_DISPLAY_WIDTH * 0.6); // 51
const SENTENCE_BREAK_MIN_WIDTH = 14;
const MAX_CUE_DURATION_MS = 7000;
const SILENCE_GAP_MS = 1300;
const READING_MS_PER_WIDTH = 55;
const MIN_READING_MS = 1000;
const MAX_READING_MS = 5000;
const LAST_WORD_TAIL_MS = 800;
const FLICKER_BRIDGE_GAP_MS = 1200;

const DUPLICATE_MERGE_GAP_MS = 250;
const SIMULTANEOUS_START_DIFF_MS = 50;

const SENTENCE_END_RE = /[.?!。？！]["'”’)\]]*$/;
const CLAUSE_END_RE = /[,;:，、；：]["'”’)\]]*$/;
const BRACKET_TAG_RE = /^(?:\[[^\]]+\]|\([^)]+\)|（[^）]+）|【[^】]+】|♪.+♪)$/;

function isCjkOrFullwidthCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x9fff) || // CJK 符号、假名、汉字
    (cp >= 0xac00 && cp <= 0xd7af) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容汉字
    (cp >= 0xff00 && cp <= 0xffef) // 全角 ASCII 与半角假名
  );
}

/** 计算字幕显示宽度：中日韩与全角字符计 2，其余字符计 1 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    width += isCjkOrFullwidthCodePoint(cp) ? 2 : 1;
  }
  return width;
}

function estimateReadingTimeMs(text: string): number {
  return Math.min(MAX_READING_MS, Math.max(MIN_READING_MS, displayWidth(text) * READING_MS_PER_WIDTH));
}

function isBracketOnlyToken(token: string): boolean {
  return BRACKET_TAG_RE.test(token.trim());
}

/** 判断两段词拼接时是否需要插入西文空格（相邻两侧任一为 CJK 字符则不加空格） */
function joinTokens(prev: string, next: string): string {
  if (!prev) return next;
  if (!next) return prev;
  const lastChar = [...prev].at(-1);
  const firstChar = [...next][0];
  const prevCjk = lastChar ? isCjkOrFullwidthCodePoint(lastChar.codePointAt(0) ?? 0) : false;
  const nextCjk = firstChar ? isCjkOrFullwidthCodePoint(firstChar.codePointAt(0) ?? 0) : false;
  return prevCjk || nextCjk ? prev + next : `${prev} ${next}`;
}

/**
 * 将 ASR 单词序列重组为可读 cue 列表：
 * - 宽度 > 84、累计时长 > 7s、相邻静音 > 1.3s 切分
 * - 句末标点且宽度 >= 14 于下一词前切分；逗号等停顿且宽度 >= 51（上限 60%）切分
 * - [Music] 等括号标记独立成条
 * - 相邻间隙 < 1.2s 自动平滑延展消除闪烁
 */
export function regroupAsrWords(words: readonly PipelineWord[]): PipelineCue[] {
  const sorted = words
    .map((w) => ({ startMs: w.startMs, text: w.text.trim() }))
    .filter((w) => w.text.length > 0)
    .sort((a, b) => a.startMs - b.startMs);

  const cues: PipelineCue[] = [];
  let cur: { startMs: number; lastWordMs: number; text: string } | null = null;
  let closeBeforeNext = false;

  const flush = (nextStartMs?: number) => {
    if (!cur) return;
    let endMs = Math.max(
      cur.startMs + estimateReadingTimeMs(cur.text),
      cur.lastWordMs + LAST_WORD_TAIL_MS,
    );
    if (nextStartMs !== undefined) {
      endMs = Math.min(endMs, nextStartMs);
    }
    if (endMs <= cur.startMs) {
      endMs = cur.startMs + MIN_READING_MS;
    }
    cues.push({ startMs: cur.startMs, endMs, text: cur.text });
    cur = null;
    closeBeforeNext = false;
  };

  for (const word of sorted) {
    const bracketTag = isBracketOnlyToken(word.text);

    if (bracketTag) {
      flush(word.startMs);
      cur = { startMs: word.startMs, lastWordMs: word.startMs, text: word.text };
      closeBeforeNext = true;
      continue;
    }

    if (cur) {
      const candidate = joinTokens(cur.text, word.text);
      const tooWide = displayWidth(candidate) > MAX_DISPLAY_WIDTH;
      const tooLong = word.startMs - cur.startMs > MAX_CUE_DURATION_MS;
      const longPause = word.startMs - cur.lastWordMs > SILENCE_GAP_MS;
      if (closeBeforeNext || tooWide || tooLong || longPause) {
        flush(word.startMs);
      }
    }

    if (!cur) {
      cur = { startMs: word.startMs, lastWordMs: word.startMs, text: word.text };
    } else {
      cur.text = joinTokens(cur.text, word.text);
      cur.lastWordMs = word.startMs;
    }

    const w = displayWidth(cur.text);
    if (SENTENCE_END_RE.test(cur.text) && w >= SENTENCE_BREAK_MIN_WIDTH) {
      closeBeforeNext = true;
    } else if (CLAUSE_END_RE.test(cur.text) && w >= CLAUSE_BREAK_WIDTH) {
      closeBeforeNext = true;
    }
  }

  flush();

  // 消除 < 1200ms 的细小空隙，避免字幕短暂消失再闪出
  for (let i = 0; i < cues.length - 1; i++) {
    const current = cues[i]!;
    const next = cues[i + 1]!;
    const gap = next.startMs - current.endMs;
    if (gap > 0 && gap < FLICKER_BRIDGE_GAP_MS) {
      current.endMs = next.startMs;
    }
  }

  return cues;
}

/**
 * 归一化手动字幕：
 * 1. 按开始时间排序并去除空串
 * 2. 合并 250ms 内重复的相同文本
 * 3. 合并开始时间差 < 50ms 的同时说话双行字幕
 * 4. 裁剪重叠区间，确保同一时刻最多一条活跃 cue
 */
export function normalizeManualCues(cues: readonly PipelineCue[]): PipelineCue[] {
  const sorted = cues
    .map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text.trim() }))
    .filter((c) => c.text.length > 0 && c.endMs > c.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const merged: PipelineCue[] = [];
  for (const cue of sorted) {
    const prev = merged.at(-1);
    if (!prev) {
      merged.push({ ...cue });
      continue;
    }

    if (prev.text === cue.text && cue.startMs - prev.endMs <= DUPLICATE_MERGE_GAP_MS) {
      prev.endMs = Math.max(prev.endMs, cue.endMs);
      continue;
    }

    if (Math.abs(cue.startMs - prev.startMs) < SIMULTANEOUS_START_DIFF_MS) {
      if (prev.text !== cue.text) {
        prev.text = `${prev.text}\n${cue.text}`;
      }
      prev.endMs = Math.max(prev.endMs, cue.endMs);
      continue;
    }

    merged.push({ ...cue });
  }

  for (let i = 0; i < merged.length - 1; i++) {
    const current = merged[i]!;
    const next = merged[i + 1]!;
    if (current.endMs > next.startMs) {
      current.endMs = next.startMs;
    }
  }

  return merged.filter((c) => c.endMs > c.startMs);
}
