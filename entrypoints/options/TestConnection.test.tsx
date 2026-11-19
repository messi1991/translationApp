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
  new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });

const unauth = () => new Response('unauthorized', { status: 401 });

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
  const btn = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!btn) throw new Error(`未找到按钮: ${text}`);
  await act(async () => {
    btn.click();
  });
}

const bodyText = () => container.textContent ?? '';

describe('设置页：测试连接', () => {
  it('未配置 key 时点测试连接显示未配置提示，不发请求', async () => {
    // 进入 openai 配置区但不填 key
    await browser.storage.local.set({
      settings: { ...DEFAULT_SETTINGS, engine: 'openai-compatible' },
    });

    await mountApp();
    await clickButton('测试连接');

    expect(bodyText()).toContain('API Key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('edge 引擎不显示测试连接按钮（无配置可测）', async () => {
    await mountApp();

    expect(container.textContent).not.toContain('测试连接');
  });

  it('鉴权失败时显示鉴权错误文案', async () => {
    await browser.storage.local.set({ settings: OPENAI_SETTINGS });
    fetchMock.mockImplementation(() => Promise.resolve(unauth()));

    await mountApp();
    await clickButton('测试连接');

    expect(bodyText()).toContain('鉴权失败');
  });

  it('成功后显示成功提示', async () => {
    await browser.storage.local.set({ settings: OPENAI_SETTINGS });
    fetchMock.mockImplementation(() => Promise.resolve(okChat()));

    await mountApp();
    await clickButton('测试连接');

    expect(bodyText()).toContain('连接成功');
  });

  it('测试中按钮禁用并显示进行中文案', async () => {
    await browser.storage.local.set({ settings: OPENAI_SETTINGS });
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    await mountApp();
    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '测试连接',
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });

    expect(bodyText()).toContain('测试中');
    expect(btn.disabled).toBe(true);

    await act(async () => {
      release(okChat());
    });
    // 消息通道多一层异步（runtime.sendMessage），再推一轮
    await act(async () => {});

    expect(bodyText()).toContain('连接成功');
    expect(bodyText()).not.toContain('测试中');
  });
});
