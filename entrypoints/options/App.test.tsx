import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS } from '@/modules/settings';
import App from '@/entrypoints/options/App';

/** 断言用的 DOM 容器与根实例，每测重建 */
let container: HTMLDivElement;
let root: Root;

declare global {
  // React 测试环境标记（react-dom 测试模式要求）
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(async () => {
  await browser.storage.local.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** 挂载设置页并等待异步读取配置完成 */
async function mountApp() {
  await act(async () => {
    root.render(<App />);
  });
}

/** 按可见标签定位表单控件 */
function queryByLabel(selector: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`未找到元素: ${selector}`);
  return el;
}

function click(el: HTMLElement) {
  act(() => {
    el.click();
  });
}

/** 触发受控输入变更（React 需经原生 setter 才能收到） */
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('设置页：修改后重开页面值保留', () => {
  it('修改目标语言并保存，重新挂载后仍为新值', async () => {
    await mountApp();

    const select = queryByLabel('select') as HTMLSelectElement;
    expect(select.value).toBe('zh-CN');

    setValue(select, 'ja');
    click(queryByLabel('button.primary'));

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await mountApp();

    expect((queryByLabel('select') as HTMLSelectElement).value).toBe('ja');
    expect(await browser.storage.local.get('settings')).toMatchObject({
      settings: { targetLanguage: 'ja' },
    });
  });

  it('修改引擎与 key 并保存，重新挂载后输入框回填', async () => {
    await mountApp();

    const selects = container.querySelectorAll('select');
    setValue(selects[1] as HTMLSelectElement, 'openai-compatible');

    const inputs = container.querySelectorAll('input');
    setValue(inputs[0] as HTMLInputElement, 'https://api.deepseek.com/v1');
    setValue(inputs[1] as HTMLInputElement, 'sk-test-key');
    setValue(inputs[2] as HTMLInputElement, 'deepseek-chat');

    click(queryByLabel('button.primary'));

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await mountApp();

    const reread = container.querySelectorAll('input');
    expect((reread[0] as HTMLInputElement).value).toBe('https://api.deepseek.com/v1');
    expect((reread[1] as HTMLInputElement).value).toBe('sk-test-key');
    expect((reread[2] as HTMLInputElement).value).toBe('deepseek-chat');
  });

  it('添加黑名单主机后保存，重新挂载后仍在列表', async () => {
    await mountApp();

    const hostInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="example.com"]',
    )!;
    setValue(hostInput, 'https://github.com/some/page');

    // 「添加」按钮是黑名单输入框后的同级按钮
    const addButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '添加',
    )!;
    click(addButton);

    await act(async () => {
      queryByLabel('button.primary').click();
    });

    const stored = (await browser.storage.local.get('settings'))
      .settings as typeof DEFAULT_SETTINGS;
    expect(stored.blockedHosts).toContain('github.com');
  });
});
