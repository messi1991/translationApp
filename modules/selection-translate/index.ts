import { createButton, positionButton, removeButton } from './button';
import { shouldActivate } from './gate';
import { extractSelection, getSelectionRect } from './selection';
import { createThrottle } from './throttle';

/** 选区变化到 UI 反应的合并窗口（毫秒） */
const SELECTION_THROTTLE_MS = 200;

export interface StartOptions {
  /** 当前页面 URL，用于黑名单判定 */
  url: string;
  /** 点击浮层按钮时的回调；T6 未接入翻译，缺省为空实现 */
  onTranslate?: (text: string) => void;
}

/**
 * 启动划词翻译：门控通过后监听 selectionchange，有选区则显示浮层按钮。
 * 返回清理函数（移除监听与按钮）。
 */
export async function startSelectionTranslate(options: StartOptions): Promise<() => void> {
  const active = await shouldActivate(options.url);
  if (!active) {
    return () => {};
  }

  const handle = () => {
    const selection = window.getSelection();
    const text = extractSelection(selection);
    if (!text) {
      removeButton();
      return;
    }

    const rect = getSelectionRect(selection);
    // 无可用矩形（如跨域 iframe 内选区）时不显示按钮，避免定位到 (0,0)
    if (!rect) {
      removeButton();
      return;
    }

    createButton({
      onClick: () => {
        options.onTranslate?.(text);
      },
    });
    positionButton(rect, {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
  };

  const throttled = createThrottle(handle, SELECTION_THROTTLE_MS);
  document.addEventListener('selectionchange', throttled);
  window.addEventListener('scroll', throttled, { passive: true });

  return () => {
    throttled.cancel();
    document.removeEventListener('selectionchange', throttled);
    window.removeEventListener('scroll', throttled);
    removeButton();
  };
}

export { shouldActivate } from './gate';
export { extractSelection, getSelectionRect } from './selection';
export { createButton, positionButton, removeButton, BUTTON_ID } from './button';
export { createThrottle } from './throttle';
