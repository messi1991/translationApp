import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractSelection, getSelectionRect } from './selection';

/** 用给定文本构造一个真实的页面选区 */
function selectText(text: string): Selection {
  const div = document.createElement('div');
  div.textContent = text;
  document.body.appendChild(div);

  const range = document.createRange();
  range.selectNodeContents(div);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return selection as Selection;
}

function clearSelection() {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
}

beforeEach(() => {
  clearSelection();
});

afterEach(() => {
  clearSelection();
});

describe('选区文本提取', () => {
  it('普通选区返回去空白后的文本', () => {
    selectText('  Hello world  ');

    expect(extractSelection(window.getSelection())).toBe('Hello world');
  });

  it('空白选区返回 null', () => {
    selectText('   ');

    expect(extractSelection(window.getSelection())).toBeNull();
  });

  it('空选区（无 range）返回 null', () => {
    expect(extractSelection(window.getSelection())).toBeNull();
  });

  it('null 选区不抛错，返回 null', () => {
    expect(extractSelection(null)).toBeNull();
  });

  it('超出长度上限的选区返回 null（避免误选整页）', () => {
    selectText('a'.repeat(5001));

    expect(extractSelection(window.getSelection(), { maxLength: 5000 })).toBeNull();
  });

  it('恰好等于上限时仍然返回', () => {
    const text = 'a'.repeat(5000);
    selectText(text);

    expect(extractSelection(window.getSelection(), { maxLength: 5000 })).toBe(text);
  });

  it('折叠选区（collapsed）返回 null', () => {
    const div = document.createElement('div');
    div.textContent = 'Hello';
    document.body.appendChild(div);
    const range = document.createRange();
    range.setStart(div.firstChild as Node, 2);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(extractSelection(selection)).toBeNull();
  });

  it('多行选区保留换行，仅去掉首尾空白', () => {
    selectText('\n  first line\n  second line  \n');

    expect(extractSelection(window.getSelection())).toBe('first line\n  second line');
  });
});

describe('选区定位', () => {
  it('返回选区包围盒的矩形', () => {
    selectText('Hello');
    // jsdom 不做布局，getBoundingClientRect 恒为 0；直接给实例打桩模拟真实布局结果
    const range = window.getSelection()!.getRangeAt(0);
    range.getBoundingClientRect = () =>
      ({ top: 100, left: 50, right: 150, bottom: 120, width: 100, height: 20 }) as DOMRect;

    const rect = getSelectionRect(window.getSelection());

    expect(rect).toEqual({ top: 100, left: 50, right: 150, bottom: 120, width: 100, height: 20 });
  });

  it('矩形全零（不可见元素）时返回 null', () => {
    selectText('Hello');
    const range = window.getSelection()!.getRangeAt(0);
    range.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;

    expect(getSelectionRect(window.getSelection())).toBeNull();
  });

  it('环境不提供 getBoundingClientRect 时返回 null 而非抛错', () => {
    selectText('Hello');
    const range = window.getSelection()!.getRangeAt(0);
    // 模拟旧 WebView / 特殊文档
    (range as unknown as Record<string, unknown>).getBoundingClientRect = undefined;

    expect(() => getSelectionRect(window.getSelection())).not.toThrow();
    expect(getSelectionRect(window.getSelection())).toBeNull();
  });

  it('无选区时返回 null', () => {
    expect(getSelectionRect(window.getSelection())).toBeNull();
  });

  it('rangeCount 为 0 时返回 null', () => {
    expect(getSelectionRect(null)).toBeNull();
  });
});
