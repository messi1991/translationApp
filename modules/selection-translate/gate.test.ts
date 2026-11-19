import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS } from '@/modules/settings';
import { shouldActivate } from './gate';

beforeEach(async () => {
  await browser.storage.local.clear();
});

afterEach(async () => {
  await browser.storage.local.clear();
});

describe('激活门控：开关', () => {
  it('功能开关关闭时不激活', async () => {
    await browser.storage.local.set({
      settings: {
        ...DEFAULT_SETTINGS,
        features: { ...DEFAULT_SETTINGS.features, selectionTranslate: false },
      },
    });

    expect(await shouldActivate('https://example.com/page')).toBe(false);
  });

  it('开关开启且站点未屏蔽时激活', async () => {
    expect(await shouldActivate('https://example.com/page')).toBe(true);
  });
});

describe('激活门控：黑名单', () => {
  it('命中黑名单的主机不激活', async () => {
    await browser.storage.local.set({
      settings: { ...DEFAULT_SETTINGS, blockedHosts: ['example.com'] },
    });

    expect(await shouldActivate('https://example.com/page')).toBe(false);
  });

  it('命中黑名单的子域不激活', async () => {
    await browser.storage.local.set({
      settings: { ...DEFAULT_SETTINGS, blockedHosts: ['example.com'] },
    });

    expect(await shouldActivate('https://docs.example.com/page')).toBe(false);
  });

  it('未被屏蔽的站点正常激活', async () => {
    await browser.storage.local.set({
      settings: { ...DEFAULT_SETTINGS, blockedHosts: ['example.com'] },
    });

    expect(await shouldActivate('https://other.org/page')).toBe(true);
  });
});

describe('激活门控：异常输入', () => {
  it('非法 URL 不激活且不抛错', async () => {
    expect(await shouldActivate('not-a-url')).toBe(false);
    expect(await shouldActivate('')).toBe(false);
  });

  it('chrome:// 等特权协议不激活', async () => {
    expect(await shouldActivate('chrome://extensions')).toBe(false);
    expect(await shouldActivate('about:blank')).toBe(false);
  });

  it('读取配置失败时不激活（宁可不打扰）', async () => {
    const original = browser.storage.local.get;
    browser.storage.local.get = () => Promise.reject(new Error('storage 损坏'));

    expect(await shouldActivate('https://example.com')).toBe(false);
    browser.storage.local.get = original;
  });
});
