import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createButton, removeButton, positionButton, BUTTON_ID } from './button';

/** 在页面中按 id 找到浮层宿主（含 shadow root） */
function host(): HTMLElement | null {
  return document.getElementById(BUTTON_ID);
}

/** 取宿主内 shadow root 的按钮元素 */
function innerButton(): HTMLButtonElement | null {
  return host()?.shadowRoot?.querySelector('button') ?? null;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  removeButton();
  document.body.innerHTML = '';
});

describe('浮层按钮：创建与销毁', () => {
  it('创建后挂到 body 并可通过 id 找到', () => {
    createButton({ onClick: () => {} });

    expect(host()).not.toBeNull();
    expect(document.body.contains(host())).toBe(true);
  });

  it('按钮位于 shadow root 内，样式与页面隔离', () => {
    createButton({ onClick: () => {} });

    const shadow = host()?.shadowRoot;
    expect(shadow).not.toBeNull();
    expect(shadow?.querySelector('style')).not.toBeNull();
    expect(innerButton()?.textContent).toContain('翻译');
  });

  it('重复创建不会产生多个宿主', () => {
    createButton({ onClick: () => {} });
    createButton({ onClick: () => {} });

    expect(document.querySelectorAll(`#${BUTTON_ID}`)).toHaveLength(1);
  });

  it('点击触发回调', () => {
    const onClick = vi.fn();
    createButton({ onClick });

    innerButton()?.click();

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('销毁后从 DOM 移除', () => {
    createButton({ onClick: () => {} });
    removeButton();

    expect(host()).toBeNull();
  });

  it('销毁不存在的按钮不抛错', () => {
    expect(() => removeButton()).not.toThrow();
  });
});

describe('浮层按钮：定位', () => {
  it('按选区矩形把按钮放在选区下方居中', () => {
    createButton({ onClick: () => {} });
    const rect = { top: 100, left: 50, right: 150, bottom: 120, width: 100, height: 20 };

    positionButton(rect, { viewportWidth: 1000, viewportHeight: 800 });

    const style = host()?.style;
    // 水平居中于选区：left = 50 + 100/2 = 100，再减去按钮半宽（估算 40 → 见实现）
    expect(Number(style?.left.replace('px', ''))).toBeGreaterThan(0);
    expect(Number(style?.top.replace('px', ''))).toBe(124);
  });

  it('选区贴近视口底部时改放到选区上方，避免超出可视区', () => {
    createButton({ onClick: () => {} });
    const rect = { top: 760, left: 50, right: 150, bottom: 790, width: 100, height: 30 };

    positionButton(rect, { viewportWidth: 1000, viewportHeight: 800 });

    const top = Number(host()?.style.top.replace('px', ''));
    expect(top).toBeLessThan(760);
  });

  it('选区贴近视口左/右边缘时不溢出屏幕', () => {
    createButton({ onClick: () => {} });
    const rect = { top: 100, left: 0, right: 5, bottom: 120, width: 5, height: 20 };

    positionButton(rect, { viewportWidth: 300, viewportHeight: 800 });

    const left = Number(host()?.style.left.replace('px', ''));
    expect(left).toBeGreaterThanOrEqual(4);
    expect(left).toBeLessThanOrEqual(300);
  });

  it('未创建按钮时定位不抛错', () => {
    expect(() =>
      positionButton(
        { top: 1, left: 1, right: 2, bottom: 2, width: 1, height: 1 },
        { viewportWidth: 100, viewportHeight: 100 },
      ),
    ).not.toThrow();
  });
});
