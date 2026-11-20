import { describe, expect, it } from 'vitest';
import {
  displayWidth,
  normalizeManualCues,
  regroupAsrWords,
  type PipelineCue,
  type PipelineWord,
} from './regroup';

describe('displayWidth', () => {
  it('ASCII 计 1 宽，中日韩与全角标点计 2 宽', () => {
    expect(displayWidth('hello')).toBe(5);
    expect(displayWidth('你好世界')).toBe(8);
    expect(displayWidth('こんにちは')).toBe(10);
    expect(displayWidth('안녕하세요')).toBe(10);
    expect(displayWidth('AI翻訳')).toBe(6);
  });
});

describe('regroupAsrWords（ASR 单词级重组规则）', () => {
  it('将细碎单词按空格合并为自然句，并在句末标点且宽度 >= 14 时于下一词前断句', () => {
    const words: PipelineWord[] = [
      { startMs: 0, text: 'Hello' },
      { startMs: 250, text: 'everyone' },
      { startMs: 600, text: 'today.' }, // "Hello everyone today." width = 21 >= 14 -> close before next
      { startMs: 2500, text: 'Welcome' },
      { startMs: 2800, text: 'back.' },
    ];
    const cues = regroupAsrWords(words);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.text).toBe('Hello everyone today.');
    expect(cues[0]?.startMs).toBe(0);
    expect(cues[0]?.endMs).toBeLessThanOrEqual(2500);
    expect(cues[1]?.text).toBe('Welcome back.');
    expect(cues[1]?.startMs).toBe(2500);
  });

  it('句末标点但宽度不足 14（如 "Dr." 或 "Hi."）时不提前断句', () => {
    const words: PipelineWord[] = [
      { startMs: 0, text: 'Dr.' },
      { startMs: 200, text: 'Smith' },
      { startMs: 500, text: 'is' },
      { startMs: 700, text: 'here.' },
    ];
    const cues = regroupAsrWords(words);
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe('Dr. Smith is here.');
  });

  it('逗号/分号等次级停顿在宽度达到上限 60%（>= 51）时断句', () => {
    // 构造前半句带逗号且长度超过 51
    const firstClauseWords = [
      'When', 'we', 'build', 'a', 'bilingual', 'subtitle', 'extension', 'for', 'modern', 'browsers,',
    ];
    const words: PipelineWord[] = [
      ...firstClauseWords.map((text, idx) => ({ startMs: idx * 200, text })),
      { startMs: 2200, text: 'reliability' },
      { startMs: 2500, text: 'matters.' },
    ];
    const cues = regroupAsrWords(words);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.text).toBe(firstClauseWords.join(' '));
    expect(cues[1]?.text).toBe('reliability matters.');
  });

  it('宽度超过 84 时强制切分，不生成超长单条字幕', () => {
    const words: PipelineWord[] = Array.from({ length: 20 }, (_, i) => ({
      startMs: i * 200,
      text: 'word' + String(i).padStart(2, '0'), // 每词 6 + 空格 1
    }));
    const cues = regroupAsrWords(words);
    expect(cues.length).toBeGreaterThanOrEqual(2);
    for (const cue of cues) {
      expect(displayWidth(cue.text)).toBeLessThanOrEqual(84);
    }
  });

  it('单条累计时长超过 7000ms 时强制切分', () => {
    const words: PipelineWord[] = [
      { startMs: 0, text: 'one' },
      { startMs: 1200, text: 'two' },
      { startMs: 2400, text: 'three' },
      { startMs: 3600, text: 'four' },
      { startMs: 4800, text: 'five' },
      { startMs: 6000, text: 'six' },
      { startMs: 7100, text: 'seven' }, // 7100 - 0 > 7000 -> 新开一条
    ];
    const cues = regroupAsrWords(words);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.text).toBe('one two three four five six');
    expect(cues[1]?.text).toBe('seven');
  });

  it('相邻两词静音间隔超过 1300ms 时断句', () => {
    const words: PipelineWord[] = [
      { startMs: 0, text: 'first' },
      { startMs: 300, text: 'part' },
      { startMs: 1700, text: 'after' }, // 1700 - 300 = 1400 > 1300
      { startMs: 2000, text: 'silence' },
    ];
    const cues = regroupAsrWords(words);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.text).toBe('first part');
    expect(cues[1]?.text).toBe('after silence');
  });

  it('[Music] / (Applause) 等纯括号音效标记独立成条，不与前后正粘连', () => {
    const words: PipelineWord[] = [
      { startMs: 0, text: 'Thank' },
      { startMs: 300, text: 'you' },
      { startMs: 1000, text: '[Applause]' },
      { startMs: 3000, text: 'Next' },
      { startMs: 3300, text: 'topic' },
    ];
    const cues = regroupAsrWords(words);
    expect(cues.map((c) => c.text)).toEqual(['Thank you', '[Applause]', 'Next topic']);
  });

  it('中日韩单词拼接时不插入多余西文空格，且小于 1200ms 的相邻间隙自动延展消除闪烁', () => {
    const words: PipelineWord[] = [
      { startMs: 0, text: '今日は' },
      { startMs: 400, text: 'いい天気ですね。' }, // 宽度 >= 14 且句号结尾 -> 下一词断句
      { startMs: 1900, text: '散歩しましょう。' },
    ];
    const cues = regroupAsrWords(words);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.text).toBe('今日はいい天気ですね。');
    // 第一条原本 endMs <= 1900，若与 1900 间隙 < 1200ms 应平滑衔接至 1900
    expect(cues[0]?.endMs).toBe(1900);
  });
});

describe('normalizeManualCues（手动字幕归一化）', () => {
  it('合并 250ms 内相同文本的连续字幕、合并 50ms 内同时开口的双人字幕，并裁剪重叠区间', () => {
    const raw: PipelineCue[] = [
      { startMs: 1000, endMs: 2000, text: 'Same line' },
      { startMs: 2150, endMs: 3200, text: 'Same line' }, // 间隔 150ms <= 250ms 且同文 -> 合并为 [1000, 3200]
      { startMs: 4000, endMs: 6000, text: '- Hello!' },
      { startMs: 4030, endMs: 5800, text: '- Hi there!' }, // 起点差 30ms < 50ms -> 合并双行
      { startMs: 5500, endMs: 7000, text: 'Next cue overlapping' }, // 裁剪上一条 endMs 至 5500
    ];

    const normalized = normalizeManualCues(raw);
    expect(normalized).toEqual([
      { startMs: 1000, endMs: 3200, text: 'Same line' },
      { startMs: 4000, endMs: 5500, text: '- Hello!\n- Hi there!' },
      { startMs: 5500, endMs: 7000, text: 'Next cue overlapping' },
    ]);
  });
});
