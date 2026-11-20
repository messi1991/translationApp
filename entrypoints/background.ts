import { defineBackground } from 'wxt/utils/define-background';
import { registerTranslateHandler } from '@/modules/translation-core/messaging';
import { purgeStaleCache } from '@/modules/translation-core/cache';

/**
 * 后台 service worker：统一翻译消息入口。
 * 所有翻译 API 请求只在此发出（key 不进入 content script）。
 */
export default defineBackground(() => {
  registerTranslateHandler();
  // prompt/逻辑版本变更后，清理不再命中的旧缓存条目（失败静默）
  void purgeStaleCache();
  console.log('[translationApp] background loaded, translate handler registered');
});
