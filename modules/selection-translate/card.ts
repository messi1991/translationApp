import { TARGET_LANGUAGES } from '@/modules/settings';
import type { TranslationErrorCode } from '@/modules/translation-core';
import { engineLabelOf, errorTextOf } from './card-labels';
import { CARD_ESTIMATED_HEIGHT, CARD_STYLE, CARD_WIDTH } from './card-style';
import type { SelectionRect } from './selection';

/** 译文卡片宿主元素 id，与浮层按钮同为页面内唯一 */
export const CARD_ID = 'translation-app-translation-card';

/** 卡片与选区的间距 */
const GAP = 8;
/** 距视口边缘的最小留白 */
const EDGE_PADDING = 8;

export interface Viewport {
  viewportWidth: number;
  viewportHeight: number;
}

/** 卡片状态：加载中 / 成功 / 失败 */
export type CardState =
  | { kind: 'loading'; source: string }
  | { kind: 'success'; source: string; translated: string; from: string; engine: string }
  /** message 仅保留给日志/诊断，卡片只展示错误码映射后的文案，不透出内部信息 */
  | { kind: 'error'; source: string; code?: TranslationErrorCode; message?: string };

export interface CardCallbacks {
  onClose: () => void;
  onRetry: (source: string) => void;
  /** 目标语言，缺省 zh-CN */
  targetLanguage?: string;
  /** 卡片内临时切换目标语言并重新翻译 */
  onTargetLanguageChange?: (targetLanguage: string, source: string) => void;
}

export interface CardLayout {
  rect: SelectionRect;
  viewport: Viewport;
}

const noop = () => {};
const FALLBACK_CALLBACKS: CardCallbacks = { onClose: noop, onRetry: noop };

/** 当前卡片回调；createCard 时替换，renderCard 复用 */
let callbacks: CardCallbacks = FALLBACK_CALLBACKS;

/** 创建（或重置）卡片宿主与回调；卡片内容随后由 renderCard 填充 */
export function createCard(next: CardCallbacks): void {
  hideCard();
  callbacks = next;
  ensureHost();
}

/** 创建（或复用）宿主并返回；shadow root 内只放 style */
function ensureHost(): HTMLElement {
  const existing = document.getElementById(CARD_ID);
  if (existing) return existing;

  const host = document.createElement('div');
  host.id = CARD_ID;
  host.style.position = 'absolute';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CARD_STYLE;
  shadow.appendChild(style);
  document.body.appendChild(host);
  return host;
}

/** 移除卡片 */
export function hideCard(): void {
  document.getElementById(CARD_ID)?.remove();
}

export function isCardVisible(): boolean {
  return document.getElementById(CARD_ID) !== null;
}

/** 按状态渲染并定位卡片；宿主不存在时先创建（沿用上次 createCard 的回调） */
export function renderCard(state: CardState, layout: CardLayout): void {
  const host = ensureHost();
  const shadow = host.shadowRoot!;
  // 整体重建内容节点（保留 style），避免状态切换时残留旧按钮
  shadow.querySelector('.st-card')?.remove();
  const card = document.createElement('div');
  card.className = 'st-card';
  card.append(buildHeader(state), buildBody(state), buildActions(state));
  shadow.appendChild(card);

  positionCard(host, layout);
}

function buildHeader(state: CardState): HTMLElement {
  const header = document.createElement('div');
  header.className = 'st-header';

  const target = callbacks.targetLanguage ?? 'zh-CN';
  if (state.kind === 'success') {
    header.append(
      badge('st-engine', engineLabelOf(state.engine)),
      badge('st-language', `${state.from} → ${target}`),
    );
  }
  if (callbacks.onTargetLanguageChange) {
    header.appendChild(buildTargetLanguageSelect(target, state.source, callbacks.onTargetLanguageChange));
  }

  const spacer = document.createElement('span');
  spacer.className = 'st-spacer';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'st-icon st-close';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭');
  close.onclick = () => {
    hideCard();
    callbacks.onClose();
  };
  header.append(spacer, close);
  return header;
}

function buildTargetLanguageSelect(
  currentTarget: string,
  source: string,
  onChange: (targetLanguage: string, source: string) => void,
): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'st-lang-select';
  select.setAttribute('aria-label', '目标语言');

  if (!TARGET_LANGUAGES.some((item) => item.code === currentTarget)) {
    const customOpt = document.createElement('option');
    customOpt.value = currentTarget;
    customOpt.textContent = currentTarget;
    select.appendChild(customOpt);
  }

  for (const item of TARGET_LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = item.code;
    opt.textContent = item.label;
    select.appendChild(opt);
  }
  select.value = currentTarget;

  select.onchange = (event) => {
    event.stopPropagation();
    onChange(select.value, source);
  };
  return select;
}

function badge(className: string, text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = `st-badge ${className}`;
  el.textContent = text;
  return el;
}

function buildBody(state: CardState): HTMLElement {
  const body = document.createElement('div');
  body.className = 'st-body';

  const original = document.createElement('p');
  original.className = 'st-original';
  original.textContent = state.source;
  body.appendChild(original);
  body.appendChild(buildResult(state));
  return body;
}

function buildResult(state: CardState): HTMLElement {
  const el = document.createElement('p');
  if (state.kind === 'loading') {
    el.className = 'st-status';
    el.textContent = '翻译中…';
  } else if (state.kind === 'success') {
    el.className = 'st-translated';
    el.textContent = state.translated;
  } else {
    el.className = 'st-status st-error';
    el.textContent = errorTextOf(state.code);
  }
  return el;
}

function buildActions(state: CardState): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'st-actions';

  if (state.kind === 'success') {
    actions.appendChild(actionButton('复制', () => void copyText(state.translated)));
  }
  if (state.kind === 'error') {
    actions.appendChild(actionButton('重试', () => callbacks.onRetry(state.source)));
  }
  return actions;
}

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'st-action';
  button.textContent = label;
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  };
  return button;
}

/** 写入剪贴板；页面无权限或浏览器不支持时静默失败 */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    /* 剪贴板不可用不影响卡片其余功能 */
  }
}

/** 定位：默认贴选区下方；下方空间不足时翻到上方，左右收拢到视口内 */
function positionCard(host: HTMLElement, layout: CardLayout): void {
  const { rect, viewport } = layout;
  const left = clamp(rect.left, EDGE_PADDING, viewport.viewportWidth - CARD_WIDTH - EDGE_PADDING);

  const below = rect.bottom + GAP;
  const fitsBelow = below + CARD_ESTIMATED_HEIGHT <= viewport.viewportHeight - EDGE_PADDING;
  const top = fitsBelow ? below : Math.max(EDGE_PADDING, rect.top - CARD_ESTIMATED_HEIGHT - GAP);

  host.style.left = `${Math.round(left)}px`;
  host.style.top = `${Math.round(top)}px`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export { engineLabelOf, errorTextOf } from './card-labels';
