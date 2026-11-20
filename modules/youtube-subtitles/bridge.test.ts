import { describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_SOURCE,
  createIsolatedBridgeClient,
  createNonce,
  postBridgeMessage,
  readBridgeMessage,
  type MainToIsolatedMessage,
} from './bridge';

describe('createNonce', () => {
  it('生成每次不同且长度足够的随机十六进制字符串', () => {
    const a = createNonce();
    const b = createNonce();
    expect(a).toMatch(/^[0-9a-f]{32,}$/);
    expect(b).toMatch(/^[0-9a-f]{32,}$/);
    expect(a).not.toBe(b);
  });
});

describe('readBridgeMessage 安全校验', () => {
  const nonce = 'deadbeefcafebabe0123456789abcdef';

  it('校验 sourceWindow、source tag、dir 与 nonce 四项全通过才返回载荷', () => {
    const valid = new MessageEvent('message', {
      source: window,
      data: {
        source: BRIDGE_SOURCE,
        dir: 'to-isolated',
        nonce,
        msg: { type: 'ready' } satisfies MainToIsolatedMessage,
      },
    });
    expect(readBridgeMessage(valid, 'to-isolated', nonce)).toEqual({ type: 'ready' });
  });

  it('拒绝跨窗口（source !== window）、错误 tag、错误方向或错误 nonce 的伪造消息', () => {
    const otherWindow = {} as Window;
    const cases = [
      new MessageEvent('message', {
        source: otherWindow,
        data: { source: BRIDGE_SOURCE, dir: 'to-isolated', nonce, msg: { type: 'ready' } },
      }),
      new MessageEvent('message', {
        source: window,
        data: { source: 'other-ext', dir: 'to-isolated', nonce, msg: { type: 'ready' } },
      }),
      new MessageEvent('message', {
        source: window,
        data: { source: BRIDGE_SOURCE, dir: 'to-main', nonce, msg: { type: 'ready' } },
      }),
      new MessageEvent('message', {
        source: window,
        data: { source: BRIDGE_SOURCE, dir: 'to-isolated', nonce: 'forged', msg: { type: 'ready' } },
      }),
      new MessageEvent('message', { source: window, data: 'not-an-object' }),
    ];
    for (const ev of cases) {
      expect(readBridgeMessage(ev, 'to-isolated', nonce)).toBeNull();
    }
  });
});

describe('createIsolatedBridgeClient', () => {
  it('握手成功后转发 get-subtitles 请求并按 requestId 匹配响应，忽略伪造 nonce 消息', async () => {
    const nonce = 'fixed-nonce-for-bridge-test-123456';
    const onMessage = (ev: MessageEvent) => {
      const msg = readBridgeMessage(ev, 'to-main', nonce);
      if (!msg) return;
      if (msg.type === 'hello') {
        postBridgeMessage('to-isolated', nonce, { type: 'ready' });
      } else if (msg.type === 'get-subtitles') {
        // 先注入一条伪造 nonce 消息试图投毒
        postBridgeMessage('to-isolated', 'evil-nonce', {
          type: 'subtitles-result',
          requestId: msg.requestId,
          result: { status: 'no-captions', videoId: 'hacked' },
        });
        postBridgeMessage('to-isolated', nonce, {
          type: 'subtitles-result',
          requestId: msg.requestId,
          result: {
            status: 'ok',
            videoId: msg.expectedVideoId,
            languageCode: 'en',
            isAsr: false,
            cues: [{ startMs: 0, endMs: 1000, text: 'Hello' }],
            words: [],
          },
        });
      }
    };
    window.addEventListener('message', onMessage);

    const client = createIsolatedBridgeClient({ nonce, handshakeTimeoutMs: 500, requestTimeoutMs: 500 });
    try {
      const res = await client.requestSubtitles('vid_1');
      expect(res).toEqual({
        status: 'ok',
        videoId: 'vid_1',
        languageCode: 'en',
        isAsr: false,
        cues: [{ startMs: 0, endMs: 1000, text: 'Hello' }],
        words: [],
      });
    } finally {
      client.destroy();
      window.removeEventListener('message', onMessage);
    }
  });

  it('MAIN world 无响应时握手超时 reject，不无限挂起', async () => {
    vi.useFakeTimers();
    const client = createIsolatedBridgeClient({
      nonce: 'timeout-nonce',
      helloIntervalMs: 20,
      handshakeTimeoutMs: 60,
      requestTimeoutMs: 100,
    });
    try {
      const promise = client.requestSubtitles('vid_timeout');
      const assertion = expect(promise).rejects.toThrow(/bridge/i);
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      client.destroy();
      vi.useRealTimers();
    }
  });

  it('AbortSignal 中止在途请求并立即 reject AbortError', async () => {
    const nonce = 'abort-nonce-123456';
    const onMessage = (ev: MessageEvent) => {
      const msg = readBridgeMessage(ev, 'to-main', nonce);
      if (msg?.type === 'hello') {
        postBridgeMessage('to-isolated', nonce, { type: 'ready' });
      }
      // get-subtitles 不回复，模拟慢请求被切视频中止
    };
    window.addEventListener('message', onMessage);

    const ac = new AbortController();
    const client = createIsolatedBridgeClient({ nonce });
    try {
      const p = client.requestSubtitles('vid_slow', ac.signal);
      setTimeout(() => ac.abort(), 10);
      await expect(p).rejects.toThrow(/abort/i);
    } finally {
      client.destroy();
      window.removeEventListener('message', onMessage);
    }
  });
});
