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
