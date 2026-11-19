export interface Throttled<A extends unknown[]> {
  (...args: A): void;
  /** 取消尚未执行的那一次调用 */
  cancel: () => void;
}

/**
 * 尾部节流：等待期内多次调用只保留最后一次参数，期满执行一次。
 * selectionchange 在拖拽选择时会高频触发，需要合并且以最终选区为准。
 */
export function createThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): Throttled<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;

  const run = () => {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    if (args) fn(...args);
  };

  const throttled = ((...args: A) => {
    lastArgs = args;
    if (timer === null) {
      timer = setTimeout(run, waitMs);
    }
  }) as Throttled<A>;

  throttled.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };

  return throttled;
}
