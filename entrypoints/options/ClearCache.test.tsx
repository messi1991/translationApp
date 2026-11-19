import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS } from '@/modules/settings';
import { registerTranslateHandler } from '@/modules/translation-core';
import App from '@/entrypoints/options/App';

declare global {
  // React 测试环境标记（react-dom 测试模式要求）
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let unregister: () => void;
let fetchMock: ReturnType<typeof vi.fn>;

const OPENAI_SETTINGS = {
  ...DEFAULT_SETTINGS,
  engine: 'openai-compatible' as const,
  engines: {
    'openai-compatible': {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'test-model',
    },
  },
};

const okChat = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: '你好' } }] }), { status: 200 });

beforeEach(async () => {
  await browser.storage.local.clear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  unregister = registerTranslateHandler();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  unregister();
  vi.unstubAllGlobals();
  act(() => root.unmount());
  container.remove();
});

async function mountApp() {
  await act(async () => {
    root.render(<App />);
  });
}

/** 点击文本匹配的按钮并等待异步完成 */
async function clickButton(text: string) {
  const btn = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.trim().startsWith(text),
  );
  if (!btn) throw new Error(`未找到按钮: ${text}`);
  await act(async () => {
    btn.click();
  });
}

const bodyText = () => container.textContent ?? '';

describe('设置页：清除翻译缓存', () => {
  it('点击后显示已清空提示', async () => {
    await browser.storage.local.set({ settings: OPENAI_SETTINGS });
    await mountApp();

    await clickButton('清除翻译缓存');

    expect(bodyText()).toContain('缓存已清空');
  });

  it('清空后原本命中的译文会重新请求', async () => {
    await browser.storage.local.set({ settings: OPENAI_SETTINGS });
    fetchMock.mockImplementation(() => Promise.resolve(okChat()));

    // 先产生一条缓存（经消息通道，命中 background 的两层缓存）
    const { requestTranslate } = await import('@/modules/translation-core');
    await requestTranslate({ text: 'Hello' });
    await requestTranslate({ text: 'Hello' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await mountApp();
    await clickButton('清除翻译缓存');

    await requestTranslate({ text: 'Hello' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('清除缓存不改变已保存的配置', async () => {
    await browser.storage.local.set({ settings: OPENAI_SETTINGS });
    await mountApp();

    await clickButton('清除翻译缓存');

    const stored = await browser.storage.local.get('settings');
    expect(stored.settings).toEqual(OPENAI_SETTINGS);
  });
});
