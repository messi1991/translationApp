/**
 * 译文卡片样式与尺寸常量。
 * 尺寸常量必须与 CARD_STYLE 中的 width 保持一致，否则定位会偏。
 */

/** 卡片宽度（用于居中与边界收拢） */
export const CARD_WIDTH = 320;

/** 卡片高度估算：仅用于判断选区下方空间是否足够 */
export const CARD_ESTIMATED_HEIGHT = 140;

export const CARD_STYLE = `
  :host {
    all: initial;
    position: absolute;
    z-index: 2147483647;
  }
  .st-card {
    box-sizing: border-box;
    width: ${CARD_WIDTH}px;
    padding: 12px 14px;
    border-radius: 8px;
    background: #fff;
    color: #111827;
    font: 400 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  }
  .st-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
  }
  .st-badge {
    padding: 1px 6px;
    border-radius: 4px;
    background: #eff6ff;
    color: #1d4ed8;
    font-size: 11px;
    font-weight: 500;
  }
  .st-spacer { flex: 1; }
  .st-icon {
    all: initial;
    cursor: pointer;
    color: #6b7280;
    font: 400 16px/1 system-ui, sans-serif;
    padding: 2px 4px;
  }
  .st-icon:hover { color: #111827; }
  .st-original {
    color: #6b7280;
    word-break: break-word;
    max-height: 72px;
    overflow: auto;
    margin: 0 0 6px;
  }
  .st-translated {
    color: #111827;
    font-size: 14px;
    word-break: break-word;
    max-height: 160px;
    overflow: auto;
    margin: 0;
  }
  .st-status { margin: 0; color: #6b7280; }
  .st-error { margin: 0; color: #b91c1c; }
  .st-actions {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
  .st-action {
    all: initial;
    cursor: pointer;
    padding: 4px 10px;
    border-radius: 6px;
    background: #f3f4f6;
    color: #111827;
    font: 500 12px/1.2 system-ui, sans-serif;
  }
  .st-action:hover { background: #e5e7eb; }
`;
