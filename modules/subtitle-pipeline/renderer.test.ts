import { afterEach, describe, expect, it } from 'vitest';
import {
  createSubtitleRenderer,
  HIDE_NATIVE_ATTR,
  NATIVE_HIDE_STYLE_ID,
  OVERLAY_HOST_ID,
} from './renderer';

function createPlayerFixture() {
  const container = document.createElement('div');
  container.id = 'movie_player';
  const video = document.createElement('video');
  container.appendChild(video);
  document.body.appendChild(container);
  return { container, video };
}

describe('createSubtitleRenderer（播放器内 Shadow DOM 双语渲染与原字幕隐藏）', () => {
  afterEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    Object.defineProperty(document, 'fullscreenElement', {
      value: null,
      configurable: true,
    });
  });

  it('在播放器容器内挂载 Shadow DOM 宿主，渲染双语（原文 + 译文），译文未就绪时仅优雅显示原文', () => {
    const { container, video } = createPlayerFixture();
    const renderer = createSubtitleRenderer({ container, video });

    const host = container.querySelector(`#${OVERLAY_HOST_ID}`);
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).not.toBeNull();

    // 仅原文（译文尚在请求中）
    renderer.renderCue({ original: 'Hello world' });
    const shadow = host!.shadowRoot!;
    expect(shadow.querySelector('.sp-original')?.textContent).toBe('Hello world');
    expect(shadow.querySelector('.sp-translated')).toBeNull();

    // 译文到达后更新为双语上下排布
    renderer.renderCue({ original: 'Hello world', translated: '你好，世界' });
    expect(shadow.querySelector('.sp-original')?.textContent).toBe('Hello world');
    expect(shadow.querySelector('.sp-translated')?.textContent).toBe('你好，世界');

    // 清空当前帧（静音间隙）
    renderer.renderCue(null);
    expect(shadow.querySelector('.sp-box')?.hasAttribute('hidden')).toBe(true);

    renderer.destroy();
    expect(container.querySelector(`#${OVERLAY_HOST_ID}`)).toBeNull();
  });

  it('原字幕隐藏开关：开启时为播放器容器打标记属性并注入隐藏样式，关闭或销毁时立即恢复原字幕', () => {
    const { container, video } = createPlayerFixture();
    const renderer = createSubtitleRenderer({
      container,
      video,
      hideNativeSubtitles: true,
      nativeSubtitleSelectors: ['.ytp-caption-window-container'],
    });

    expect(container.hasAttribute(HIDE_NATIVE_ATTR)).toBe(true);
    const styleEl = document.getElementById(NATIVE_HIDE_STYLE_ID);
    expect(styleEl?.textContent).toContain('.ytp-caption-window-container');

    renderer.setHideNativeSubtitles(false);
    expect(container.hasAttribute(HIDE_NATIVE_ATTR)).toBe(false);

    renderer.setHideNativeSubtitles(true);
    expect(container.hasAttribute(HIDE_NATIVE_ATTR)).toBe(true);

    renderer.destroy();
    expect(container.hasAttribute(HIDE_NATIVE_ATTR)).toBe(false);
  });

  it('renderNotice 展示不支持提示条（如直播 / Shorts），renderCue 或 clearNotice 时收起', () => {
    const { container, video } = createPlayerFixture();
    const renderer = createSubtitleRenderer({ container, video });

    renderer.renderNotice('当前暂不支持直播字幕双语翻译');
    const host = container.querySelector(`#${OVERLAY_HOST_ID}`)!;
    const notice = host.shadowRoot!.querySelector('.sp-notice');
    expect(notice?.textContent).toBe('当前暂不支持直播字幕双语翻译');

    renderer.clearNotice();
    expect(host.shadowRoot!.querySelector('.sp-notice')).toBeNull();
    renderer.destroy();
  });

  it('<video> 元素自身进入全屏时自动隐藏 DOM 叠加层并写入原生 TextTrack，退出全屏后恢复', () => {
    const { container, video } = createPlayerFixture();

    // 为 jsdom 的 video 模拟 addTextTrack 与 VTTCue
    const addedCues: Array<{ startTime: number; endTime: number; text: string }> = [];
    const fakeTrack = {
      mode: 'disabled',
      cues: addedCues,
      addCue(cue: { startTime: number; endTime: number; text: string }) {
        addedCues.push(cue);
      },
      removeCue(cue: { startTime: number; endTime: number; text: string }) {
        const idx = addedCues.indexOf(cue);
        if (idx >= 0) addedCues.splice(idx, 1);
      },
    };
    (video as unknown as { addTextTrack: () => typeof fakeTrack }).addTextTrack = () => fakeTrack;

    const renderer = createSubtitleRenderer({ container, video });
    renderer.renderCue({
      original: 'Fullscreen line',
      translated: '全屏字幕',
      startMs: 1000,
      endMs: 4000,
    });

    // 模拟 <video> 直接成为 fullscreenElement
    Object.defineProperty(document, 'fullscreenElement', {
      value: video,
      configurable: true,
    });
    document.dispatchEvent(new Event('fullscreenchange'));

    expect(fakeTrack.mode).toBe('showing');
    expect(addedCues).toHaveLength(1);
    expect(addedCues[0]?.text).toBe('Fullscreen line\n全屏字幕');

    // 退出全屏回到普通播放器模式
    Object.defineProperty(document, 'fullscreenElement', {
      value: null,
      configurable: true,
    });
    document.dispatchEvent(new Event('fullscreenchange'));

    expect(fakeTrack.mode).toBe('disabled');
    expect(addedCues).toHaveLength(0);

    renderer.destroy();
  });
});
