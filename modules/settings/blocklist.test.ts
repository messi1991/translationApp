import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { getSettings, saveSettings } from './store';
import { isBlocked, isHostBlocked } from './blocklist';

describe('isHostBlocked（纯函数）', () => {
  const list = ['github.com', 'example.org'];

  it('精确主机命中', () => {
    expect(isHostBlocked('github.com', list)).toBe(true);
  });

  it('子域命中', () => {
    expect(isHostBlocked('gist.github.com', list)).toBe(true);
  });

  it('不同域名不命中', () => {
    expect(isHostBlocked('gitlab.com', list)).toBe(false);
  });

  it('相似前缀不命中（防止 notgithub.com 误伤）', () => {
    expect(isHostBlocked('notgithub.com', list)).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(isHostBlocked('GITHUB.COM', list)).toBe(true);
  });

  it('空列表不命中', () => {
    expect(isHostBlocked('github.com', [])).toBe(false);
  });
});

describe('isBlocked（读配置判定）', () => {
  beforeEach(async () => {
    await browser.storage.local.clear();
  });

  it('黑名单内 URL 返回 true', async () => {
    const current = await getSettings();
    await saveSettings({ ...current, blockedHosts: ['github.com'] });
    expect(await isBlocked('https://gist.github.com/some/page')).toBe(true);
  });

  it('黑名单外 URL 返回 false', async () => {
    const current = await getSettings();
    await saveSettings({ ...current, blockedHosts: ['github.com'] });
    expect(await isBlocked('https://example.com/page')).toBe(false);
  });

  it('默认配置（空黑名单）返回 false', async () => {
    expect(await isBlocked('https://github.com/page')).toBe(false);
  });
});
