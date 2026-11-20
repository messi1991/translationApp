import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, saveSettings } from '@/modules/settings';
import type { MessageResponse } from '@/modules/translation-core';
import { BUTTON_ID } from './button';
import { CARD_ID } from './card';
import { startSelectionTranslate } from './index';

let cleanup: (() => void) | null = null;

/** 在文档中选中给定文本；stubRect 为 true 时模拟真实布局矩形 */
function select(text: string, stubRect = false) {
  const div = document.createElement('div');
  div.textContent = text;
  document.body.appendChild(div);
  const range = document.createRange();
  range.selectNodeContents(div);
  if (stubRect) {
    range.getBoundingClientRect = () =>
      ({ top: 100, left: 50, right: 150, bottom: 120, width: 100, height: 20 }) as DOMRect;
  }
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function clearSelection() {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
}

const host = () => document.getElementById(BUTTON_ID);

beforeEach(async () => {
  await browser.storage.local.clear();
  clearSelection();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.useRealTimers();
  clearSelection();
});

/** 触发 selectionchange 并推进节流窗口 */
function triggerSelectionChange() {
  document.dispatchEvent(new Event('selectionchange'));
  vi.advanceTimersByTime(300);
}

describe('划词控制器：初始化', () => {
  it('黑名单站点不初始化任何 UI', async () => {
    await browser.storage.local.set({
      settings: { ...DEFAULT_SETTINGS, blockedHosts: ['example.com'] },
    });

    cleanup = await startSelectionTranslate({ url: 'https://example.com/page' });
    select('Hello');
    triggerSelectionChange();

    expect(host()).toBeNull();
  });

  it('功能开关关闭时不初始化 UI', async () => {
    await browser.storage.local.set({
      settings: {
        ...DEFAULT_SETTINGS,
        features: { ...DEFAULT_SETTINGS.features, selectionTranslate: false },
      },
    });

    cleanup = await startSelectionTranslate({ url: 'https://example.com/page' });
    select('Hello');
    triggerSelectionChange();

    expect(host()).toBeNull();
  });

  it('启用站点选中文本后出现浮层按钮', async () => {
    cleanup = await startSelectionTranslate({ url: 'https://example.com/page' });
    select('Hello world', true);
    vi.advanceTimersByTime(300);

    expect(host()).not.toBeNull();
    expect(host()?.shadowRoot?.querySelector('button')?.textContent).toContain('翻译');
  });

  it('清除选区后按钮消失', async () => {
    cleanup = await startSelectionTranslate({ url: 'https://example.com/page' });
    select('Hello', true);
    vi.advanceTimersByTime(300);
    expect(host()).not.toBeNull();

    clearSelection();
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(300);

    expect(host()).toBeNull();
  });

  it('空白选区不显示按钮', async () => {
    cleanup = await startSelectionTranslate({ url: 'https://example.com/page' });
    select('   ');
    vi.advanceTimersByTime(300);

    expect(host()).toBeNull();
  });
});

describe('划词控制器：健壮性', () => {
  it('iframe 内选区（无可用矩形）不抛错且不显示按钮', async () => {
    cleanup = await startSelectionTranslate({ url: 'https://example.com/page' });
    select('Hello');
    // jsdom 的 Range 无 getBoundingClientRect，等价于无法定位的跨域 iframe 选区
    expect(() => {
      document.dispatchEvent(new Event('selectionchange'));
      vi.advanceTimersByTime(300);
    }).not.toThrow();
    expect(host()).toBeNull();
  });

  it('清理函数移除按钮与监听', async () => {
    cleanup = await startSelectionTranslate({ url: 'https://example.com/page' });
    select('Hello', true);
    vi.advanceTimersByTime(300);
    expect(host()).not.toBeNull();

    cleanup?.();
    cleanup = null;
    expect(host()).toBeNull();

    select('Hello again', true);
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(300);
    expect(host()).toBeNull();
  });

  it('点击按钮不抛错（无翻译通道时静默）', async () => {
    cleanup = await startSelectionTranslate({ url: 'https://example.com/page' });
    select('Hello', true);
    vi.advanceTimersByTime(300);

    const button = host()?.shadowRoot?.querySelector('button');
    expect(() => button?.click()).not.toThrow();
  });
});

describe('划词控制器：译文卡片', () => {
  const cardShadow = () => document.getElementById(CARD_ID)?.shadowRoot ?? null;
  const cardText = (selector: string) =>
    cardShadow()?.querySelector(selector)?.textContent ?? null;

  const ok = (text: string): MessageResponse => ({
    ok: true,
    result: { text, from: 'en', engine: 'edge' },
  });

  function clickButton() {
    const button = host()?.shadowRoot?.querySelector('button');
    button?.click();
  }

  it('点击按钮经 translate 回调请求翻译并展示译文', async () => {
    const translate = vi.fn().mockResolvedValue(ok('你好'));
    cleanup = await startSelectionTranslate({
      url: 'https://example.com/page',
      translate,
    });
    select('Hello', true);
    vi.advanceTimersByTime(300);

    clickButton();

    await vi.waitFor(() => expect(cardText('.st-translated')).toBe('你好'));
    expect(translate).toHaveBeenCalledWith('Hello');
  });

  it('未注入 translate 时回落到翻译消息通道', async () => {
    cleanup = await startSelectionTranslate({ url: 'https://example.com/page' });
    select('Hello', true);
    vi.advanceTimersByTime(300);

    clickButton();

    // fake browser 无 background 监听，消息通道失败 → 错误态
    await vi.waitFor(() => expect(document.getElementById(CARD_ID)).not.toBeNull());
    expect(cardText('.st-status')).not.toBeNull();
  });

  it('新选区出现时关闭旧卡片', async () => {
    const translate = vi.fn().mockResolvedValue(ok('你好'));
    cleanup = await startSelectionTranslate({
      url: 'https://example.com/page',
      translate,
    });
    select('Hello', true);
    vi.advanceTimersByTime(300);
    clickButton();
    await vi.waitFor(() => expect(document.getElementById(CARD_ID)).not.toBeNull());

    select('Hello world', true);
    triggerSelectionChange();

    expect(document.getElementById(CARD_ID)).toBeNull();
  });

  it('清理函数移除按钮与卡片', async () => {
    const translate = vi.fn().mockResolvedValue(ok('你好'));
    cleanup = await startSelectionTranslate({
      url: 'https://example.com/page',
      translate,
    });
    select('Hello', true);
    vi.advanceTimersByTime(300);
    clickButton();
    await vi.waitFor(() => expect(document.getElementById(CARD_ID)).not.toBeNull());

    cleanup?.();
    cleanup = null;

    expect(host()).toBeNull();
    expect(document.getElementById(CARD_ID)).toBeNull();
  });

  it('卡片默认目标语言为简体中文（zh-CN），可在卡片内切换为英语（en）或日语（ja）重新翻译', async () => {
    const translate = vi
      .fn()
      .mockImplementation(async (_text: string, to?: string) => {
        if (to === 'ja') return ok('こんにちは');
        if (to === 'en') return ok('Hello there');
        return ok('你好');
      });

    cleanup = await startSelectionTranslate({
      url: 'https://example.com/page',
      translate,
    });
    select('Bonjour', true);
    vi.advanceTimersByTime(300);
    clickButton();

    await vi.waitFor(() => expect(cardText('.st-translated')).toBe('你好'));
    expect(cardText('.st-language')).toBe('en → zh-CN');

    const selectEl = cardShadow()?.querySelector('.st-lang-select') as HTMLSelectElement | null;
    expect(selectEl).not.toBeNull();
    expect(selectEl?.value).toBe('zh-CN');

    selectEl!.value = 'ja';
    selectEl!.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(cardText('.st-translated')).toBe('こんにちは'));
    expect(cardText('.st-language')).toBe('en → ja');
    expect(translate).toHaveBeenLastCalledWith('Bonjour', 'ja');
  });
});

describe('划词控制器：配置实时生效（无需刷新页面）', () => {
  it('运行中关闭划词开关或将当前站点加入黑名单，立即移除按钮与卡片；重新开启后立即恢复', async () => {
    const translate = vi.fn().mockResolvedValue({
      ok: true as const,
      result: { text: '你好', from: 'en', engine: 'edge' as const },
    });
    await saveSettings(DEFAULT_SETTINGS);
    cleanup = await startSelectionTranslate({
      url: 'https://example.com/article',
      translate,
    });

    select('Hello', true);
    vi.advanceTimersByTime(300);
    expect(host()).not.toBeNull();

    host()?.shadowRoot?.querySelector('button')?.click();
    await vi.waitFor(() => expect(document.getElementById(CARD_ID)).not.toBeNull());

    // 1. 弹窗关闭全局划词开关 -> 立即收起按钮和卡片，新选区不弹按钮
    await saveSettings({
      ...DEFAULT_SETTINGS,
      features: { ...DEFAULT_SETTINGS.features, selectionTranslate: false },
    });
    await vi.waitFor(() => {
      expect(host()).toBeNull();
      expect(document.getElementById(CARD_ID)).toBeNull();
    });

    select('World', true);
    triggerSelectionChange();
    expect(host()).toBeNull();

    // 2. 弹窗重新开启全局划词开关 -> 无需刷新页面即可重新划词
    await saveSettings(DEFAULT_SETTINGS);
    // 等待异步门控挂载完成
    await vi.waitFor(async () => {
      select('Again', true);
      triggerSelectionChange();
      expect(host()).not.toBeNull();
    });

    // 3. 将当前域名写入黑名单 -> 立即停用并清理浮层
    await saveSettings({
      ...DEFAULT_SETTINGS,
      blockedHosts: ['example.com'],
    });
    await vi.waitFor(() => expect(host()).toBeNull());
  });
});
