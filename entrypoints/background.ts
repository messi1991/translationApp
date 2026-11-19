import { defineBackground } from 'wxt/utils/define-background';
import { registerTranslateHandler } from '@/modules/translation-core/messaging';

/**
 * 后台 service worker：统一翻译消息入口。
 * 所有翻译 API 请求只在此发出（key 不进入 content script）。
 */
export default defineBackground(() => {
  registerTranslateHandler();
  console.log('[translationApp] background loaded, translate handler registered');
});
