import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIsolatedBridgeClient, postBridgeMessage, readBridgeMessage } from './bridge';
import { startMainWorldBridge, type PlayerResponseLike } from './main-world';

function mountMoviePlayer(getResponse: () => PlayerResponseLike | undefined): HTMLElement {
  const el = document.createElement('div');
  el.id = 'movie_player';
  (el as unknown as { getPlayerResponse: () => PlayerResponseLike | undefined }).getPlayerResponse =
    getResponse;
  document.body.appendChild(el);
  return el;
}

describe('startMainWorldBridge', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    delete (window as unknown as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('首条 hello 锁定 nonce，拒绝页面第三方脚本随后发送的不同 nonce 消息', async () => {
    mountMoviePlayer(() => ({
      videoDetails: { videoId: 'v1' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=v1' }],
        },
      },
    }));

    const stop = startMainWorldBridge({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hi' }] }] }),
      }) as unknown as typeof fetch,
    });

    const client = createIsolatedBridgeClient({ nonce: 'trusted-nonce-001' });
    const receivedByAttacker: unknown[] = [];
    const attackerListener = (ev: MessageEvent) => {
      const m = readBridgeMessage(ev, 'to-isolated', 'attacker-nonce');
      if (m) receivedByAttacker.push(m);
    };
    window.addEventListener('message', attackerListener);

    try {
      const res = await client.requestSubtitles('v1');
      expect(res.status).toBe('ok');

      // 攻击者尝试发送新 hello 与 get-subtitles，MAIN world 必须静默忽略
      postBridgeMessage('to-main', 'attacker-nonce', { type: 'hello' });
      postBridgeMessage('to-main', 'attacker-nonce', {
        type: 'get-subtitles',
        requestId: 99,
        expectedVideoId: 'v1',
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(receivedByAttacker).toHaveLength(0);
    } finally {
      window.removeEventListener('message', attackerListener);
      client.destroy();
      stop();
    }
  });

  it('视频切换防串：播放器短暂残留旧 videoId 时轮询等待新 videoId 就绪后再选轨拉取', async () => {
    let calls = 0;
    mountMoviePlayer(() => {
      calls += 1;
      // 前两次仍返回上一个视频 old_vid，第三次才更新为 new_vid
      if (calls < 3) {
        return {
          videoDetails: { videoId: 'old_vid' },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                { languageCode: 'fr', baseUrl: 'https://www.youtube.com/api/timedtext?v=old_vid' },
              ],
            },
          },
        };
      }
      return {
        videoDetails: { videoId: 'new_vid' },
        streamingData: {
          adaptiveFormats: [
            { audioTrack: { id: 'en-US.4' }, xtags: btoa('acont=original:lang=en-US') },
          ],
        },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              { languageCode: 'ar', kind: 'asr', vssId: 'a.ar', baseUrl: 'https://www.youtube.com/api/timedtext?v=new_vid&lang=ar' },
              { languageCode: 'en', kind: 'asr', vssId: 'a.en', baseUrl: 'https://www.youtube.com/api/timedtext?v=new_vid&lang=en' },
            ],
          },
        },
      };
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          events: [
            {
              tStartMs: 500,
              dDurationMs: 1200,
              segs: [{ utf8: 'hello' }, { utf8: ' world', tOffsetMs: 300 }],
            },
          ],
        }),
    });

    const stop = startMainWorldBridge({
      pollIntervalMs: 10,
      pollTimeoutMs: 500,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const client = createIsolatedBridgeClient();

    try {
      const res = await client.requestSubtitles('new_vid');
      expect(res).toEqual({
        status: 'ok',
        videoId: 'new_vid',
        languageCode: 'en',
        isAsr: true,
        cues: [{ startMs: 500, endMs: 1700, text: 'hello world' }],
        words: [
          { startMs: 500, text: 'hello' },
          { startMs: 800, text: 'world' },
        ],
      });
      // 确保从未去拉 old_vid 或阿拉伯语配音轨
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('v=new_vid');
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('lang=en');
    } finally {
      client.destroy();
      stop();
    }
  });

  it('直播视频返回 status: "live"，无字幕视频返回 status: "no-captions"', async () => {
    let current: PlayerResponseLike = {
      videoDetails: { videoId: 'live_vid', isLiveContent: true },
    };
    mountMoviePlayer(() => current);

    const stop = startMainWorldBridge({ pollIntervalMs: 10, pollTimeoutMs: 200 });
    const client = createIsolatedBridgeClient();

    try {
      expect(await client.requestSubtitles('live_vid')).toEqual({
        status: 'live',
        videoId: 'live_vid',
      });

      current = {
        videoDetails: { videoId: 'silent_vid' },
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
      };
      expect(await client.requestSubtitles('silent_vid')).toEqual({
        status: 'no-captions',
        videoId: 'silent_vid',
      });
    } finally {
      client.destroy();
      stop();
    }
  });

  it('#movie_player 响应尚无 captionTracks 时优先采用带字幕的 ytInitialPlayerResponse', async () => {
    mountMoviePlayer(() => ({ videoDetails: { videoId: 'late_vid' } }));
    (window as unknown as { ytInitialPlayerResponse?: PlayerResponseLike }).ytInitialPlayerResponse = {
      videoDetails: { videoId: 'late_vid' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=late_vid' },
          ],
        },
      },
    };

    const stop = startMainWorldBridge({
      pollIntervalMs: 10,
      pollTimeoutMs: 200,
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hi' }] }] }),
      }) as unknown as typeof fetch,
    });
    const client = createIsolatedBridgeClient();

    try {
      const res = await client.requestSubtitles('late_vid');
      expect(res.status).toBe('ok');
      if (res.status === 'ok') {
        expect(res.languageCode).toBe('en');
        expect(res.cues).toEqual([{ startMs: 0, endMs: 1000, text: 'Hi' }]);
      }
    } finally {
      client.destroy();
      stop();
    }
  });

  it('直接复用横取到的播放器字幕体，不再自己发请求', async () => {
    mountMoviePlayer(() => ({
      videoDetails: { videoId: 'sniff_vid' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=sniff_vid' },
          ],
        },
      },
    }));

    const playerUrl =
      'https://www.youtube.com/api/timedtext?v=sniff_vid&lang=en&fmt=json3&pot=token-abc';

    const body = JSON.stringify({
      events: [{ tStartMs: 0, dDurationMs: 800, segs: [{ utf8: 'POT works' }] }],
    });
    const fetchImpl = vi.fn(async () => {
      const response = { ok: true, status: 200, text: async () => body, clone: () => response };
      return response;
    });

    vi.stubGlobal('fetch', fetchImpl);
    const stop = startMainWorldBridge({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const client = createIsolatedBridgeClient();

    try {
      // 模拟播放器自己请求字幕（带 POT）：横取发生并缓存响应体
      await window.fetch(playerUrl);
      await vi.waitFor(() => {
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      });

      const res = await client.requestSubtitles('sniff_vid');
      expect(res.status).toBe('ok');
      if (res.status === 'ok') {
        expect(res.languageCode).toBe('en');
        expect(res.cues).toEqual([{ startMs: 0, endMs: 800, text: 'POT works' }]);
      }
      // 全程只有播放器那一次请求，扩展没有重发
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      client.destroy();
      stop();
    }
  });

  it('借播放器请求里的 POT 参数重拉目标轨道', async () => {
    mountMoviePlayer(() => ({
      videoDetails: { videoId: 'graft_vid' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=graft_vid' },
          ],
        },
      },
    }));

    const donorUrl = 'https://www.youtube.com/api/timedtext?v=graft_vid&lang=ja&pot=tok-1';
    const grafted = JSON.stringify({
      events: [{ tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'Grafted' }] }],
    });
    const makeResponse = (text: string) => {
      const response = { ok: true, status: 200, text: async () => text, clone: () => response };
      return response;
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      // 播放器那次请求返回空体：只提供会话参数（POT），不提供内容
      if (url === donorUrl) return makeResponse('');
      if (url.includes('pot=tok-1') && url.includes('fmt=json3')) return makeResponse(grafted);
      return makeResponse('');
    });

    vi.stubGlobal('fetch', fetchImpl);
    const stop = startMainWorldBridge({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sniffWaitMs: 500,
    });
    const client = createIsolatedBridgeClient();

    try {
      const pending = client.requestSubtitles('graft_vid');
      // 首轮直拉失败后，播放器才发出带 POT 的请求
      setTimeout(() => {
        void window.fetch(donorUrl);
      }, 60);

      const res = await pending;
      expect(res.status).toBe('ok');
      if (res.status === 'ok') {
        expect(res.cues).toEqual([{ startMs: 0, endMs: 1500, text: 'Grafted' }]);
      }
    } finally {
      client.destroy();
      stop();
    }
  });

  it('json3 返回 200 + 空 body 时回退到同 URL 的 XML 字幕格式', async () => {
    mountMoviePlayer(() => ({
      videoDetails: { videoId: 'xml_vid' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=xml_vid' },
          ],
        },
      },
    }));

    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('fmt=json3')) {
        return { ok: true, status: 200, text: async () => '' };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<?xml version="1.0"?><transcript><text start="1.5" dur="2">Hello XML</text></transcript>',
      };
    });

    const stop = startMainWorldBridge({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sniffWaitMs: 50,
    });
    const client = createIsolatedBridgeClient();

    try {
      const res = await client.requestSubtitles('xml_vid');
      expect(res.status).toBe('ok');
      if (res.status === 'ok') {
        expect(res.cues).toEqual([{ startMs: 1500, endMs: 3500, text: 'Hello XML' }]);
      }
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      client.destroy();
      stop();
    }
  });

  it('两条候选 URL 均为空 body 时改用备用客户端重取字幕 URL', async () => {
    mountMoviePlayer(() => ({
      videoDetails: { videoId: 'pot_vid' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=pot_vid' },
          ],
        },
      },
    }));

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('youtubei/v1/player')) {
        expect(init?.method).toBe('POST');
        expect(String(init?.body)).toContain('ANDROID');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            videoDetails: { videoId: 'pot_vid' },
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [
                  {
                    languageCode: 'en',
                    baseUrl: 'https://www.youtube.com/api/timedtext?v=pot_vid&alt=1',
                  },
                ],
              },
            },
          }),
        };
      }
      if (url.includes('alt=1')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: 'Fallback works' }] }] }),
        };
      }
      return { ok: true, status: 200, text: async () => '' };
    });

    const stop = startMainWorldBridge({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sniffWaitMs: 50,
    });
    const client = createIsolatedBridgeClient();

    try {
      const res = await client.requestSubtitles('pot_vid');
      expect(res.status).toBe('ok');
      if (res.status === 'ok') {
        expect(res.languageCode).toBe('en');
        expect(res.cues).toEqual([{ startMs: 0, endMs: 1200, text: 'Fallback works' }]);
      }
    } finally {
      client.destroy();
      stop();
    }
  });

  it('所有候选均无内容时返回带诊断信息的 error 状态', async () => {
    mountMoviePlayer(() => ({
      videoDetails: { videoId: 'dead_vid' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=dead_vid' },
          ],
        },
      },
    }));

    const stop = startMainWorldBridge({
      fetchImpl: vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' }) as unknown as typeof fetch,
      sniffWaitMs: 50,
    });
    const client = createIsolatedBridgeClient();

    try {
      const res = await client.requestSubtitles('dead_vid');
      expect(res.status).toBe('error');
      if (res.status === 'error') {
        expect(res.message).toContain('json3 HTTP 200（0 字节）');
        expect(res.message).toContain('xml HTTP 200（0 字节）');
      }
    } finally {
      client.destroy();
      stop();
    }
  });

  it('#movie_player 尚未挂载时可回退读取 window.ytInitialPlayerResponse（若 videoId 匹配）', async () => {
    (window as unknown as { ytInitialPlayerResponse?: PlayerResponseLike }).ytInitialPlayerResponse = {
      videoDetails: { videoId: 'initial_vid' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { languageCode: 'ja', baseUrl: 'https://www.youtube.com/api/timedtext?v=initial_vid' },
          ],
        },
      },
    };

    const stop = startMainWorldBridge({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({ events: [{ tStartMs: 100, dDurationMs: 900, segs: [{ utf8: 'こんにちは' }] }] }),
      }) as unknown as typeof fetch,
    });
    const client = createIsolatedBridgeClient();

    try {
      const res = await client.requestSubtitles('initial_vid');
      expect(res.status).toBe('ok');
      if (res.status === 'ok') {
        expect(res.videoId).toBe('initial_vid');
        expect(res.cues).toEqual([{ startMs: 100, endMs: 1000, text: 'こんにちは' }]);
      }
    } finally {
      client.destroy();
      stop();
    }
  });
});
