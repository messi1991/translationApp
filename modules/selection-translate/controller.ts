import type { MessageResponse } from '@/modules/translation-core';
import {
  createCard,
  hideCard,
  isCardVisible,
  renderCard,
  type CardState,
  type Viewport,
} from './card';
import type { SelectionRect } from './selection';

export type TranslateFn = (text: string, to?: string) => Promise<MessageResponse>;

export interface ControllerOptions {
  /** 翻译通道；缺省由 content script 注入基于消息的实现 */
  translate: TranslateFn;
  /** 视口尺寸，用于卡片定位 */
  viewport: Viewport;
  /** 初始目标语言（缺省 zh-CN） */
  targetLanguage?: string;
  /** 是否在卡片上展示目标语言切换器（点击后重新翻译） */
  enableLanguageSwitch?: boolean;
  /** 卡片内切换目标语言时的可选回调（如持久化或通知外部） */
  onTargetLanguageChange?: (targetLanguage: string) => void;
}

export interface TranslateController {
  /** 翻译并展示卡片；重复触发同一文本会被忽略 */
  translate: (text: string, rect: SelectionRect) => void;
  /** 收起卡片（不结束控制器） */
  dismiss: () => void;
  /** 结束控制器并移除卡片；之前的在途响应全部作废 */
  destroy: () => void;
}

/**
 * 创建翻译控制器。
 *
 * 请求作废策略：每次请求递增序号，响应到达时序号不匹配即丢弃，
 * 因此「先发后到」的旧响应不会覆盖新选区对应的卡片。
 */
export function createTranslateController(options: ControllerOptions): TranslateController {
  let requestId = 0;
  let lastText: string | null = null;
  let currentTarget = options.targetLanguage ?? 'zh-CN';
  let lastTarget: string | null = null;
  let destroyed = false;

  const show = (state: CardState, rect: SelectionRect) => {
    try {
      renderCard(state, { rect, viewport: options.viewport });
    } catch {
      /* 页面 DOM 异常时静默降级，不打断浏览 */
    }
  };

  const run = (text: string, rect: SelectionRect, targetOverride?: string) => {
    const id = ++requestId;
    const target = targetOverride ?? currentTarget;
    currentTarget = target;
    lastText = text;
    lastTarget = target;
    createCard({
      onClose: () => {
        requestId += 1;
        lastText = null;
        lastTarget = null;
      },
      onRetry: (source: string) => run(source, rect, currentTarget),
      targetLanguage: target,
      ...(options.enableLanguageSwitch
        ? {
            onTargetLanguageChange: (nextTarget: string, source: string) => {
              options.onTargetLanguageChange?.(nextTarget);
              run(source, rect, nextTarget);
            },
          }
        : {}),
    });
    show({ kind: 'loading', source: text }, rect);

    const settle = (state: CardState) => {
      if (destroyed || id !== requestId) return;
      show(state, rect);
    };

    const callPromise =
      target !== (options.targetLanguage ?? 'zh-CN')
        ? options.translate(text, target)
        : options.translate(text);

    callPromise.then(
      (res) => {
        settle(
          res.ok
            ? {
                kind: 'success',
                source: text,
                translated: res.result.text,
                from: res.result.from,
                engine: res.result.engine,
              }
            : { kind: 'error', source: text, code: res.code, message: res.message },
        );
      },
      () => settle({ kind: 'error', source: text, code: 'unknown' }),
    );
  };

  return {
    translate: (text, rect) => {
      if (destroyed) return;
      // 同一文本且目标语言未变时重复点击（或节流抖动导致的重复事件）不重复请求
      if (lastText === text && lastTarget === currentTarget && isCardVisible()) {
        return;
      }
      run(text, rect, currentTarget);
    },
    dismiss: () => {
      requestId += 1;
      lastText = null;
      lastTarget = null;
      hideCard();
    },
    destroy: () => {
      destroyed = true;
      requestId += 1;
      lastText = null;
      lastTarget = null;
      hideCard();
    },
  };
}
