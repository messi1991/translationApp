import { requestTranslate, type MessageResponse } from '@/modules/translation-core';
import { getSettings } from '@/modules/settings';
import { createButton, positionButton, removeButton } from './button';
import { createTranslateController } from './controller';
import { shouldActivate } from './gate';
import { extractSelection, getSelectionRect } from './selection';
import { createThrottle } from './throttle';

/** 选区变化到 UI 反应的合并窗口（毫秒） */
const SELECTION_THROTTLE_MS = 200;

/** 缺省翻译通道：经 background 消息翻译，密钥不进入本上下文 */
const defaultTranslate = (text: string): Promise<MessageResponse> => requestTranslate({ text });

export interface StartOptions {
  /** 当前页面 URL，用于黑名单判定 */
  url: string;
  /** 翻译通道；缺省走 background 消息，测试与复用场景可注入 */
  translate?: (text: string) => Promise<MessageResponse>;
}

/** 读取目标语言用于卡片徽标；失败时交给卡片走默认值 */
async function loadTargetLanguage(): Promise<string | undefined> {
  try {
    return (await getSettings()).targetLanguage;
  } catch {
    return undefined;
  }
}

/**
 * 启动划词翻译：门控通过后监听 selectionchange，有选区则显示浮层按钮，
 * 点击按钮翻译并在选区旁展示译文卡片。
 * 返回清理函数（移除监听、按钮与卡片）。
 */
export async function startSelectionTranslate(options: StartOptions): Promise<() => void> {
  const active = await shouldActivate(options.url);
  if (!active) {
    return () => {};
  }

  const controller = createTranslateController({
    translate: options.translate ?? defaultTranslate,
    viewport: { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight },
    targetLanguage: await loadTargetLanguage(),
  });

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

    // 选区已变化：旧卡片不再对应当前选区，先收起
    controller.dismiss();

    createButton({
      onClick: () => {
        controller.translate(text, getSelectionRect(window.getSelection()) ?? rect);
      },
    });
    positionButton(rect, viewportOf());
  };

  const throttled = createThrottle(handle, SELECTION_THROTTLE_MS);
  document.addEventListener('selectionchange', throttled);
  window.addEventListener('scroll', throttled, { passive: true });

  return () => {
    throttled.cancel();
    document.removeEventListener('selectionchange', throttled);
    window.removeEventListener('scroll', throttled);
    controller.destroy();
    removeButton();
  };
}

function viewportOf() {
  return { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
}

export { shouldActivate } from './gate';
export { extractSelection, getSelectionRect } from './selection';
export { createButton, positionButton, removeButton, BUTTON_ID } from './button';
export { createThrottle } from './throttle';
export { createCard, renderCard, hideCard, isCardVisible, errorTextOf, CARD_ID } from './card';
export { createTranslateController } from './controller';
