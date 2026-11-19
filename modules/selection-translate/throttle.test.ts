import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThrottle } from './throttle';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('节流', () => {
  it('连续调用只在等待期结束后执行一次，且用最后一次参数', () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn, 200);

    throttled('a');
    throttled('b');
    throttled('c');
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('c');
  });

  it('执行后再调用会重新开始计时', () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn, 100);

    throttled('a');
    vi.advanceTimersByTime(100);
    throttled('b');
    vi.advanceTimersByTime(100);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('b');
  });

  it('cancel 取消尚未执行的调用', () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn, 100);

    throttled('a');
    throttled.cancel();
    vi.advanceTimersByTime(200);

    expect(fn).not.toHaveBeenCalled();
  });

  it('不同实例互不影响', () => {
    const a = vi.fn();
    const b = vi.fn();
    const ta = createThrottle(a, 100);
    const tb = createThrottle(b, 100);

    ta('x');
    tb('y');
    vi.advanceTimersByTime(100);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
