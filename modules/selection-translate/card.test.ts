import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CARD_ID,
  createCard,
  errorTextOf,
  hideCard,
  isCardVisible,
  renderCard,
  type CardState,
} from './card';

const ANCHOR = { top: 100, left: 50, right: 150, bottom: 120, width: 100, height: 20 };
const VIEWPORT = { viewportWidth: 1024, viewportHeight: 768 };

const host = () => document.getElementById(CARD_ID);
const shadow = () => host()?.shadowRoot ?? null;
const textOf = (selector: string) => shadow()?.querySelector(selector)?.textContent ?? null;

/** 取卡片上的所有按钮文案（用于断言按钮是否存在） */
function buttonLabels(): string[] {
  const buttons = shadow()?.querySelectorAll('button') ?? [];
  return Array.from(buttons).map((b) => b.textContent ?? '');
}

function render(state: CardState) {
  renderCard(state, { rect: ANCHOR, viewport: VIEWPORT });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  hideCard();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('译文卡片：渲染', () => {
  it('成功态展示原文与译文', () => {
    render({ kind: 'success', source: 'Hello', translated: '你好', from: 'en', engine: 'edge' });

    expect(host()).not.toBeNull();
    expect(textOf('.st-original')).toBe('Hello');
    expect(textOf('.st-translated')).toBe('你好');
  });

  it('引擎与语言以徽标展示（语言码转可读名）', () => {
    render({ kind: 'success', source: 'Hello', translated: '你好', from: 'en', engine: 'edge' });

    expect(textOf('.st-engine')).toBe('Edge');
    expect(textOf('.st-language')).toBe('en → zh-CN');
  });

  it('未知语言码原样展示', () => {
    render({ kind: 'success', source: 'x', translated: 'y', from: 'xx', engine: 'openai-compatible' });

    expect(textOf('.st-engine')).toBe('AI');
    expect(textOf('.st-language')).toBe('xx → zh-CN');
  });

  it('加载态展示「翻译中」且无重试按钮', () => {
    render({ kind: 'loading', source: 'Hello' });

    expect(textOf('.st-status')).toContain('翻译中');
    expect(buttonLabels()).not.toContain('重试');
  });

  it('错误态展示错误文案且有重试按钮', () => {
    render({ kind: 'error', source: 'Hello', code: 'network', message: '原始错误信息' });

    expect(textOf('.st-status')).toContain('网络');
    expect(textOf('.st-status')).not.toContain('原始错误信息');
    expect(buttonLabels()).toContain('重试');
  });

  it('重复渲染复用同一宿主，不叠加节点', () => {
    render({ kind: 'loading', source: 'Hello' });
    render({ kind: 'success', source: 'Hello', translated: '你好', from: 'en', engine: 'edge' });

    expect(document.querySelectorAll(`#${CARD_ID}`)).toHaveLength(1);
    expect(shadow()?.querySelectorAll('.st-card')).toHaveLength(1);
    expect(textOf('.st-translated')).toBe('你好');
  });
});

describe('译文卡片：交互', () => {
  it('点击关闭按钮后卡片移除', () => {
    const onClose = vi.fn();
    createCard({ onClose, onRetry: vi.fn() });
    render({ kind: 'loading', source: 'Hello' });

    findButton('×')?.click();

    expect(onClose).toHaveBeenCalledOnce();
    expect(host()).toBeNull();
  });

  it('错误态点击重试回调原文', () => {
    const onRetry = vi.fn();
    createCard({ onClose: vi.fn(), onRetry });
    render({ kind: 'error', source: 'Hello', code: 'network', message: 'x' });

    findButton('重试')?.click();

    expect(onRetry).toHaveBeenCalledWith('Hello');
  });

  it('点击复制按钮写入剪贴板', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    createCard({ onClose: vi.fn(), onRetry: vi.fn() });
    render({ kind: 'success', source: 'Hello', translated: '你好', from: 'en', engine: 'edge' });

    findButton('复制')?.click();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('你好'));
  });

  it('剪贴板不可用时不抛错', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    createCard({ onClose: vi.fn(), onRetry: vi.fn() });
    render({ kind: 'success', source: 'Hello', translated: '你好', from: 'en', engine: 'edge' });

    expect(() => findButton('复制')?.click()).not.toThrow();
  });
});

describe('译文卡片：定位与可见性', () => {
  it('默认贴在选区下方', () => {
    render({ kind: 'loading', source: 'Hello' });

    // 选区 bottom=120，间距 8
    expect(host()?.style.top).toBe('128px');
  });

  it('视口底部空间不足时翻到选区上方', () => {
    renderCard(
      { kind: 'loading', source: 'Hello' },
      { rect: { ...ANCHOR, top: 700, bottom: 720 }, viewport: VIEWPORT },
    );

    const top = Number.parseInt(host()?.style.top ?? '', 10);
    expect(top).toBeLessThan(700);
  });

  it('左右边缘自动收拢，不溢出视口', () => {
    renderCard(
      { kind: 'loading', source: 'Hello' },
      { rect: { ...ANCHOR, left: 1000, right: 1020 }, viewport: VIEWPORT },
    );

    const left = Number.parseInt(host()?.style.left ?? '', 10);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(VIEWPORT.viewportWidth);
  });

  it('hideCard 后 isCardVisible 为 false', () => {
    render({ kind: 'loading', source: 'Hello' });
    expect(isCardVisible()).toBe(true);

    hideCard();
    expect(isCardVisible()).toBe(false);
  });
});

describe('错误文案映射', () => {
  it.each([
    ['network', '网络连接失败，请检查网络后重试'],
    ['rate-limit', '请求过于频繁，请稍后再试'],
    ['unsupported-language', '该语言组合暂不支持'],
    ['authentication', '引擎鉴权失败，请检查密钥设置'],
    ['unknown', '翻译失败，请稍后重试'],
  ] as const)('%s → %s', (code, expected) => {
    expect(errorTextOf(code)).toBe(expected);
  });

  it('非错误码（缺省）回退到通用文案', () => {
    expect(errorTextOf(undefined)).toBe('翻译失败，请稍后重试');
  });
});

function findButton(label: string): HTMLButtonElement | null {
  const buttons = shadow()?.querySelectorAll('button') ?? [];
  return Array.from(buttons).find((b) => b.textContent === label) ?? null;
}
