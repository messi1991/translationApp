/** 选区文本上限：超过视为误选整页，不触发翻译 */
export const DEFAULT_MAX_SELECTION_LENGTH = 5000;

export interface ExtractOptions {
  /** 文本长度上限，默认 5000 */
  maxLength?: number;
}

/** 选区在视口中的包围盒（只保留定位与卡片布局需要的字段） */
export interface SelectionRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * 提取选区文本。
 * 返回 null 的情形：无选区、折叠选区、纯空白、超出长度上限。
 */
export function extractSelection(
  selection: Selection | null,
  options: ExtractOptions = {},
): string | null {
  const maxLength = options.maxLength ?? DEFAULT_MAX_SELECTION_LENGTH;
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const text = selection.toString().trim();
  if (!text || text.length > maxLength) {
    return null;
  }
  return text;
}

/** 取选区包围盒；无有效选区或矩形全零时返回 null */
export function getSelectionRect(selection: Selection | null): SelectionRect | null {
  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  // 少数环境（旧 WebView、特殊文档）不提供该方法，缺失时按无定位处理
  if (typeof range.getBoundingClientRect !== 'function') {
    return null;
  }

  const box = range.getBoundingClientRect();
  if (!box) {
    return null;
  }
  if (box.width === 0 && box.height === 0 && box.top === 0 && box.left === 0) {
    return null;
  }

  return {
    top: box.top,
    left: box.left,
    right: box.right,
    bottom: box.bottom,
    width: box.width,
    height: box.height,
  };
}
