import type { SelectionRect } from './selection';

/** 浮层宿主元素 id，页面内唯一 */
export const BUTTON_ID = 'translation-app-floating-button';

/** 按钮尺寸估算（用于居中与边界收拢） */
const BUTTON_WIDTH = 80;
const BUTTON_HEIGHT = 32;
/** 按钮与选区的间距 */
const GAP = 4;
/** 距视口边缘的最小留白 */
const EDGE_PADDING = 4;

export interface Viewport {
  viewportWidth: number;
  viewportHeight: number;
}

export interface ButtonOptions {
  onClick: () => void;
}

const STYLE = `
  :host {
    all: initial;
    position: absolute;
    z-index: 2147483647;
  }
  button {
    all: initial;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    border-radius: 6px;
    background: #2563eb;
    color: #fff;
    font: 500 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    white-space: nowrap;
  }
  button:hover { background: #1d4ed8; }
`;

/** 创建（或复用）浮层宿主，返回 shadow root */
function ensureHost(): ShadowRoot {
  const existing = document.getElementById(BUTTON_ID);
  if (existing?.shadowRoot) return existing.shadowRoot;

  const host = document.createElement('div');
  host.id = BUTTON_ID;
  document.body.appendChild(host);
  // 页面样式可能干扰宿主，统一在此处兜住
  host.style.position = 'absolute';
  return host.attachShadow({ mode: 'open' });
}

/**
 * 创建浮层按钮。重复调用复用同一宿主，仅替换点击回调，
 * 避免选区变化时反复增删节点。
 */
export function createButton(options: ButtonOptions): void {
  const shadow = ensureHost();
  const style = shadow.querySelector('style') ?? document.createElement('style');
  style.textContent = STYLE;
  if (!style.isConnected) shadow.appendChild(style);

  let button = shadow.querySelector('button');
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.textContent = '翻译';
    shadow.appendChild(button);
  }
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.onClick();
  };
}

/** 把按钮定位到选区下方居中；空间不足时翻到上方，并收拢到视口内 */
export function positionButton(rect: SelectionRect, viewport: Viewport): void {
  const host = document.getElementById(BUTTON_ID);
  if (!host) return;

  const centerX = rect.left + rect.width / 2;
  const left = clamp(
    centerX - BUTTON_WIDTH / 2,
    EDGE_PADDING,
    viewport.viewportWidth - BUTTON_WIDTH - EDGE_PADDING,
  );

  const below = rect.bottom + GAP;
  const fitsBelow = below + BUTTON_HEIGHT <= viewport.viewportHeight - EDGE_PADDING;
  const top = fitsBelow ? below : Math.max(EDGE_PADDING, rect.top - BUTTON_HEIGHT - GAP);

  host.style.left = `${Math.round(left)}px`;
  host.style.top = `${Math.round(top)}px`;
}

/** 移除浮层（离开页面或关闭功能时调用） */
export function removeButton(): void {
  document.getElementById(BUTTON_ID)?.remove();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
