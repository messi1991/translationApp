import { describe, expect, it, vi } from 'vitest';
import { cueAt, startVideoClock } from './clock';
import type { PipelineCue } from './regroup';

describe('cueAt（二分查找 + 重叠回溯）', () => {
  it('常规非重叠区间准确命中，左闭右开 [startMs, endMs)，空白间隙返回 -1', () => {
    const cues: PipelineCue[] = [
      { startMs: 1000, endMs: 2500, text: 'A' },
      { startMs: 3000, endMs: 4500, text: 'B' },
      { startMs: 4500, endMs: 6000, text: 'C' },
    ];
    expect(cueAt(cues, 500)).toBe(-1);
    expect(cueAt(cues, 1000)).toBe(0);
    expect(cueAt(cues, 2499)).toBe(0);
    expect(cueAt(cues, 2500)).toBe(-1);
    expect(cueAt(cues, 4500)).toBe(2);
    expect(cueAt(cues, 6000)).toBe(-1);
  });

  it('重叠 cue 下：后面短 cue 已结束但前面长 cue 仍在持续时，回溯返回仍在有效期内的长 cue', () => {
    const cues: PipelineCue[] = [
      { startMs: 1000, endMs: 8000, text: 'Long narrator line' },
      { startMs: 2000, endMs: 3000, text: 'Short interjection 1' },
      { startMs: 3500, endMs: 4200, text: 'Short interjection 2' },
    ];
    // t=2500 时最新开始的 cue[1] 活跃 -> 返回 1
    expect(cueAt(cues, 2500)).toBe(1);
    // t=3200 时 cue[1] 已结束，但 cue[0] (endMs=8000) 仍活跃 -> 回溯返回 0
    expect(cueAt(cues, 3200)).toBe(0);
    // t=5000 时 cue[1]、cue[2] 均已结束，回溯 2 步命中 cue[0]
    expect(cueAt(cues, 5000)).toBe(0);
    // t=8500 时全部结束 -> -1
    expect(cueAt(cues, 8500)).toBe(-1);
  });
});

describe('startVideoClock（requestVideoFrameCallback 时钟与事件联动）', () => {
  it('优先使用 requestVideoFrameCallback 的 mediaTime 驱动，seeked / pause / ratechange 即时同步且暂停后停止空转', () => {
    const video = document.createElement('video');
    let paused = false;
    let currentTime = 1.5;
    Object.defineProperty(video, 'paused', { get: () => paused });
    Object.defineProperty(video, 'currentTime', { get: () => currentTime });

    let rvfcId = 0;
    let lastCb: ((now: number, meta: { mediaTime: number }) => void) | null = null;
    const cancelSpy = vi.fn();

    (
      video as unknown as {
        requestVideoFrameCallback: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
        cancelVideoFrameCallback: (id: number) => void;
      }
    ).requestVideoFrameCallback = (cb) => {
      rvfcId += 1;
      lastCb = cb;
      return rvfcId;
    };
    (
      video as unknown as { cancelVideoFrameCallback: (id: number) => void }
    ).cancelVideoFrameCallback = cancelSpy;

    const ticks: Array<{ timeMs: number; reason: string }> = [];
    const stop = startVideoClock(video, (timeMs, reason) => {
      ticks.push({ timeMs: Math.round(timeMs), reason });
    });

    // 启动立刻基于 currentTime 触发一次 init tick，并注册首帧 rVFC
    expect(ticks[0]).toEqual({ timeMs: 1500, reason: 'init' });
    expect(lastCb).not.toBeNull();

    // 模拟视频帧到达（mediaTime = 2.25s）
    const cb1 = lastCb!;
    lastCb = null;
    cb1(16, { mediaTime: 2.25 });
    expect(ticks.at(-1)).toEqual({ timeMs: 2250, reason: 'frame' });
    // 未暂停时自动续订下一帧
    expect(lastCb).not.toBeNull();

    // 模拟暂停：立即按 currentTime 触发一次（保证暂停时字幕不消失），随后帧回调不再续订
    paused = true;
    currentTime = 2.8;
    video.dispatchEvent(new Event('pause'));
    expect(ticks.at(-1)).toEqual({ timeMs: 2800, reason: 'pause' });

    const cb2 = lastCb!;
    lastCb = null;
    cb2(32, { mediaTime: 2.8 });
    expect(lastCb).toBeNull();

    // 模拟 seeked：reason 为 'seek' 供调度器重算窗口
    currentTime = 120.4;
    video.dispatchEvent(new Event('seeked'));
    expect(ticks.at(-1)).toEqual({ timeMs: 120_400, reason: 'seek' });

    // 模拟 2 倍速恢复播放
    paused = false;
    video.dispatchEvent(new Event('ratechange'));
    video.dispatchEvent(new Event('play'));
    expect(lastCb).not.toBeNull();

    stop();
    expect(cancelSpy).toHaveBeenCalled();
  });

  it('不支持 requestVideoFrameCallback 的环境自动降级到 requestAnimationFrame', () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'paused', { get: () => false });
    Object.defineProperty(video, 'currentTime', { get: () => 3.2 });

    let rafCb: FrameRequestCallback | null = null;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCb = cb;
      return 42;
    });
    const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    const ticks: number[] = [];
    const stop = startVideoClock(video, (ms) => ticks.push(Math.round(ms)));

    expect(rafSpy).toHaveBeenCalled();
    expect(rafCb).not.toBeNull();
    rafCb!(16);
    expect(ticks).toContain(3200);

    stop();
    expect(cancelRafSpy).toHaveBeenCalledWith(42);
    rafSpy.mockRestore();
    cancelRafSpy.mockRestore();
  });
});
