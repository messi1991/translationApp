import { describe, expect, it, vi } from 'vitest';
import { buildJson3Url, fetchJson3Track, parseJson3, type Json3Payload } from './json3';

describe('buildJson3Url', () => {
  it('在已有 query 的 baseUrl 上设置 fmt=json3 且保留原参数', () => {
    const url = buildJson3Url('https://www.youtube.com/api/timedtext?v=abc&lang=en');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('v')).toBe('abc');
    expect(parsed.searchParams.get('lang')).toBe('en');
    expect(parsed.searchParams.get('fmt')).toBe('json3');
  });

  it('覆盖已有的其他 fmt 参数为 json3', () => {
    const url = buildJson3Url('https://www.youtube.com/api/timedtext?v=abc&fmt=srv3');
    expect(new URL(url).searchParams.get('fmt')).toBe('json3');
  });
});

describe('parseJson3', () => {
  it('手动字幕：合并同一 event 的 segs 并保留起止毫秒', () => {
    const payload: Json3Payload = {
      events: [
        { tStartMs: 1000, dDurationMs: 2500, segs: [{ utf8: 'Hello ' }, { utf8: 'world!' }] },
        { tStartMs: 4000, dDurationMs: 1500, segs: [{ utf8: 'Line 1\nLine 2' }] },
      ],
    };
    const res = parseJson3(payload, { isAsr: false });
    expect(res.cues).toEqual([
      { startMs: 1000, endMs: 3500, text: 'Hello world!' },
      { startMs: 4000, endMs: 5500, text: 'Line 1 Line 2' },
    ]);
    expect(res.words).toEqual([]);
  });

  it('忽略纯换行 aAppend 事件、无 segs 事件及空文本', () => {
    const payload: Json3Payload = {
      events: [
        { tStartMs: 0, dDurationMs: 500 },
        { tStartMs: 500, dDurationMs: 500, aAppend: 1, segs: [{ utf8: '\n' }] },
        { tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: '   ' }] },
        { tStartMs: 1500, dDurationMs: 1000, segs: [{ utf8: 'Valid' }] },
      ],
    };
    const res = parseJson3(payload, { isAsr: false });
    expect(res.cues).toEqual([{ startMs: 1500, endMs: 2500, text: 'Valid' }]);
  });

  it('缺失 dDurationMs 时用下一条有效事件的 tStartMs 兜底，末尾条目用保底时长', () => {
    const payload: Json3Payload = {
      events: [
        { tStartMs: 1000, segs: [{ utf8: 'First' }] },
        { tStartMs: 2200, segs: [{ utf8: 'Second' }] },
      ],
    };
    const res = parseJson3(payload, { isAsr: false });
    expect(res.cues[0]).toEqual({ startMs: 1000, endMs: 2200, text: 'First' });
    expect(res.cues[1]?.startMs).toBe(2200);
    expect(res.cues[1]?.endMs).toBeGreaterThan(2200);
  });

  it('ASR 字幕：按 tStartMs + tOffsetMs 提取单词时间序列，同时产出事件级 cues', () => {
    const payload: Json3Payload = {
      events: [
        {
          tStartMs: 1000,
          dDurationMs: 3000,
          segs: [
            { utf8: 'so' },
            { utf8: ' what', tOffsetMs: 320 },
            { utf8: ' we', tOffsetMs: 640 },
          ],
        },
        { tStartMs: 1990, dDurationMs: 2010, aAppend: 1, segs: [{ utf8: '\n' }] },
        {
          tStartMs: 2000,
          dDurationMs: 2000,
          segs: [{ utf8: 'have' }, { utf8: ' here', tOffsetMs: 400 }],
        },
      ],
    };
    const res = parseJson3(payload, { isAsr: true });
    expect(res.words).toEqual([
      { startMs: 1000, text: 'so' },
      { startMs: 1320, text: 'what' },
      { startMs: 1640, text: 'we' },
      { startMs: 2000, text: 'have' },
      { startMs: 2400, text: 'here' },
    ]);
    expect(res.cues).toHaveLength(2);
    expect(res.cues[0]?.text).toBe('so what we');
  });
});

describe('fetchJson3Track', () => {
  it('请求 fmt=json3 URL 并返回解析结果', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          events: [{ tStartMs: 500, dDurationMs: 1500, segs: [{ utf8: 'Hi' }] }],
        }),
    });
    const res = await fetchJson3Track('https://www.youtube.com/api/timedtext?v=1', {
      isAsr: false,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.youtube.com/api/timedtext?v=1&fmt=json3',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(res.cues).toEqual([{ startMs: 500, endMs: 2000, text: 'Hi' }]);
  });

  it('HTTP 非 2xx 或空响应体（POT 拦截常见空 body）抛错不静默返回空字幕', async () => {
    const nonOk = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => '' });
    await expect(
      fetchJson3Track('https://www.youtube.com/api/timedtext?v=1', {
        isAsr: false,
        fetchImpl: nonOk as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/403/);

    const emptyBody = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '   ' });
    await expect(
      fetchJson3Track('https://www.youtube.com/api/timedtext?v=1', {
        isAsr: false,
        fetchImpl: emptyBody as unknown as typeof fetch,
      }),
    ).rejects.toThrow();
  });
});
