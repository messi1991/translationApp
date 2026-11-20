import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '@/modules/settings';
import { BUTTON_ID, startSelectionTranslate } from '@/modules/selection-translate';
import App from './App';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('Popup 工具栏弹窗（T12）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    fakeBrowser.reset();
    await saveSettings(DEFAULT_SETTINGS);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  async function mountPopup(props?: { getActiveTabUrl?: () => Promise<string | undefined>; openOptions?: () => Promise<void> | void }) {
    await act(async () => {
      root.render(<App {...props} />);
    });
  }

  function findCheckboxByLabel(labelText: string): HTMLInputElement {
    const labels = Array.from(container.querySelectorAll('label'));
    const hit = labels.find((el) => el.textContent?.includes(labelText));
    const input = hit?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (!input) throw new Error('未找到开关: ' + labelText);
    return input;
  }

  it('展示当前引擎、目标语言、全局开关与当前站点状态，点击「打开设置」触发 openOptionsPage', async () => {
    const openOptions = vi.fn();
    await saveSettings({
      ...DEFAULT_SETTINGS,
      targetLanguage: 'ja',
      engine: 'openai-compatible',
      engines: {
        'openai-compatible': {
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-ok',
          model: 'deepseek-chat',
        },
      },
    });

    await mountPopup({
      getActiveTabUrl: async () => 'https://docs.python.org/3/tutorial/',
      openOptions,
    });

    expect(container.textContent).toContain('OpenAI 兼容 · deepseek-chat');
    expect(container.textContent).toContain('日本語');
    expect(container.textContent).toContain('docs.python.org');

    const settingsBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('设置'),
    );
    expect(settingsBtn).not.toBeUndefined();
    await act(async () => {
      settingsBtn!.click();
    });
    expect(openOptions).toHaveBeenCalledTimes(1);
  });

  it('切换「在此站点启用」立即将当前主机写入/移出 blockedHosts', async () => {
    await mountPopup({
      getActiveTabUrl: async () => 'https://www.reddit.com/r/typescript',
    });

    const siteToggle = findCheckboxByLabel('在此站点启用');
    expect(siteToggle.checked).toBe(true);

    await act(async () => {
      siteToggle.click();
    });

    expect((await getSettings()).blockedHosts).toEqual(['www.reddit.com']);
    expect(siteToggle.checked).toBe(false);

    await act(async () => {
      siteToggle.click();
    });
    expect((await getSettings()).blockedHosts).toEqual([]);
    expect(siteToggle.checked).toBe(true);
  });

  it('弹窗切换划词开关后，正在浏览的目标页面无需刷新立即生效', async () => {
    // 模拟目标页面已挂载划词 content script 且用户选中了一段文本
    const stopPage = await startSelectionTranslate({
      url: 'https://example.org/post',
    });

    const textNode = document.createElement('p');
    textNode.textContent = 'Selected paragraph';
    document.body.appendChild(textNode);
    const range = document.createRange();
    range.selectNodeContents(textNode);
    range.getBoundingClientRect = () =>
      ({ top: 80, left: 40, right: 160, bottom: 100, width: 120, height: 20 }) as DOMRect;
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise((r) => setTimeout(r, 240));
    expect(document.getElementById(BUTTON_ID)).not.toBeNull();

    // 打开弹窗并关闭「划词翻译」开关
    await mountPopup({
      getActiveTabUrl: async () => 'https://example.org/post',
    });

    const selectionToggle = findCheckboxByLabel('划词翻译');
    expect(selectionToggle.checked).toBe(true);

    await act(async () => {
      selectionToggle.click();
    });

    // 目标页面无需刷新，浮层按钮立即消失且配置落盘为 false
    await vi.waitFor(() => {
      expect(document.getElementById(BUTTON_ID)).toBeNull();
    });
    expect((await getSettings()).features.selectionTranslate).toBe(false);

    stopPage();
    // 顺带验证 browser.tabs API 在未传 prop 时的降级不会报错
    await act(async () => {
      root.render(<App />);
    });
    expect(browser).toBeDefined();
  });
});
