import { afterEach, describe, expect, it, vi } from 'vitest';
import { OVERLAY_HOST_ID } from './renderer';
import { startSubtitlePipeline } from './index';

describe('startSubtitlePipeline（重组/归一化 + 调度 + 帧同步渲染全链路）', () => {
  afterEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('ASR 单词轨道重组后随视频时间切换双语字幕，当前活跃字幕译文异步返回时立刻刷新 DOM，暂停保持显示', async () => {
    const container = document.createElement('div');
    const video = document.createElement('video');
    let currentTime = 0.2;
    let paused = false;
    Object.defineProperty(video, 'currentTime', { get: () => currentTime });
    Object.defineProperty(video, 'paused', { get: () => paused });

    let frameCb: ((now: number, meta: { mediaTime: number }) => void) | null = null;
    (
      video as unknown as {
        requestVideoFrameCallback: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
        cancelVideoFrameCallback: () => void;
      }
    ).requestVideoFrameCallback = (cb) => {
      frameCb = cb;
      return 1;
    };
    (video as unknown as { cancelVideoFrameCallback: () => void }).cancelVideoFrameCallback = () => {};

    container.appendChild(video);
    document.body.appendChild(container);

    const deferred: { resolve?: (res: { ok: true; translations: string[] }) => void } = {};
    const translateBatch = vi.fn(
      () =>
        new Promise<{ ok: true; translations: string[] }>((resolve) => {
          deferred.resolve = resolve;
        }),
    );

    const session = startSubtitlePipeline({
      container,
      video,
      isAsr: true,
      cues: [],
      words: [
        { startMs: 0, text: 'Welcome' },
        { startMs: 300, text: 'everyone' },
        { startMs: 600, text: 'here.' }, // width >= 14 + '.' -> cue 0
        { startMs: 3000, text: 'Second' },
        { startMs: 3400, text: 'sentence.' }, // cue 1
      ],
      hideNativeSubtitles: true,
      translateBatch,
    });

    const shadow = container.querySelector(`#${OVERLAY_HOST_ID}`)!.shadowRoot!;

    // 译文尚未返回时先展示重组后的原文
    expect(shadow.querySelector('.sp-original')?.textContent).toBe('Welcome everyone here.');
    expect(shadow.querySelector('.sp-translated')).toBeNull();

    // 异步译文到达，即使视频帧还未推进也立即补上当前活跃 cue 的译文
    deferred.resolve!({
      ok: true,
      translations: ['欢迎大家来到这里。', '第二句话。'],
    });

    await vi.waitFor(() => {
      expect(shadow.querySelector('.sp-translated')?.textContent).toBe('欢迎大家来到这里。');
    });

    // 推进视频帧到 3.2s -> 切换到第二条双语字幕
    currentTime = 3.2;
    frameCb!(32, { mediaTime: 3.2 });
    expect(shadow.querySelector('.sp-original')?.textContent).toBe('Second sentence.');
    expect(shadow.querySelector('.sp-translated')?.textContent).toBe('第二句话。');

    // 暂停在 3.5s -> 字幕保持显示不消失
    paused = true;
    currentTime = 3.5;
    video.dispatchEvent(new Event('pause'));
    expect(shadow.querySelector('.sp-original')?.textContent).toBe('Second sentence.');
    expect(shadow.querySelector('.sp-translated')?.textContent).toBe('第二句话。');

    session.destroy();
    expect(container.querySelector(`#${OVERLAY_HOST_ID}`)).toBeNull();
  });

  it('翻译失败时在叠加层提示原因并自动隐藏，原文不受影响', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { get: () => 0, configurable: true });
    Object.defineProperty(video, 'paused', { get: () => true, configurable: true });
    container.appendChild(video);
    document.body.appendChild(container);

    const translateBatch = vi.fn(async () => ({
      ok: false as const,
      message: '网络请求失败，请检查网络后重试',
    }));

    const session = startSubtitlePipeline({
      container,
      video,
      isAsr: false,
      cues: [{ startMs: 0, endMs: 3000, text: 'Hello there' }],
      translateBatch,
    });

    try {
      const shadow = container.querySelector(`#${OVERLAY_HOST_ID}`)!.shadowRoot!;
      await vi.advanceTimersByTimeAsync(0);
      expect(shadow.querySelector('.sp-notice')?.textContent).toBe(
        '网络请求失败，请检查网络后重试',
      );
      expect(shadow.querySelector('.sp-original')?.textContent).toBe('Hello there');

      await vi.advanceTimersByTimeAsync(6000);
      expect(shadow.querySelector('.sp-notice')).toBeNull();
      expect(shadow.querySelector('.sp-original')?.textContent).toBe('Hello there');
    } finally {
      session.destroy();
      vi.useRealTimers();
    }
  });
});
