import { defineContentScript } from 'wxt/utils/define-content-script';
import { startMainWorldBridge } from '@/modules/youtube-subtitles/main-world';

/**
 * YouTube MAIN world content script。
 * 在页面脚本执行前绑定首次随机 nonce 握手，读取 #movie_player 的 captionTracks 并拉取 json3 字幕；
 * 本脚本位于页面共享上下文，不触碰任何扩展设置与 API key。
 */
export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    startMainWorldBridge();
  },
});
