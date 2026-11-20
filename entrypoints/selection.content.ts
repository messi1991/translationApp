import { defineContentScript } from 'wxt/utils/define-content-script';
import { startSelectionTranslate } from '@/modules/selection-translate';

/**
 * 划词翻译 content script。
 * 仅做选区检测与浮层 UI；翻译请求经消息交给 background，密钥不进入此上下文。
 */
export default defineContentScript({
  matches: ['*://*/*'],
  async main(ctx) {
    let cleanup: () => void = () => {};

    const start = async () => {
      cleanup();
      cleanup = await startSelectionTranslate({ url: location.href });
    };

    await start();

    // SPA 路由跳转后重新判定（换页可能进入黑名单站点）
    ctx.addEventListener(window, 'wxt:locationchange', () => {
      void start();
    });
  },
});
