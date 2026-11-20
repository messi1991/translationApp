import { defineContentScript } from 'wxt/utils/define-content-script';
import { startYouTubeSubtitles } from '@/modules/youtube-subtitles';

/**
 * YouTube isolated world content script。
 * 在 document_start 启动随机 nonce 握手，串联页面检测 → 门控 → MAIN 桥 → subtitle-pipeline 双语同步渲染。
 */
export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_start',
  main(ctx) {
    const handle = startYouTubeSubtitles();
    ctx.onInvalidated(() => {
      handle.destroy();
    });
  },
});
