import { defineContentScript } from 'wxt/utils/define-content-script';

/**
 * 划词翻译 content script 占位。
 * T6 接入 selection-translate 模块：selectionchange 检测与浮层按钮。
 */
export default defineContentScript({
  matches: ['*://*/*'],
  main() {
    console.log('[translationApp] content script loaded');
  },
});
