import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageResponse } from '@/modules/translation-core';
import { createTranslateController } from './controller';
import { CARD_ID } from './card';

const ANCHOR = { top: 100, left: 50, right: 150, bottom: 120, width: 100, height: 20 };
const VIEWPORT = { viewportWidth: 1024, viewportHeight: 768 };

const shadow = () => document.getElementById(CARD_ID)?.shadowRoot ?? null;
const textOf = (selector: string) => shadow()?.querySelector(selector)?.textContent ?? null;

/** 可控的延迟 Promise，用于模拟乱序响应 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ok = (text: string): MessageResponse => ({ ok: true, result: { text, from: 'en', engine: 'edge' } });
const fail = (message: string): MessageResponse => ({ ok: false, code: 'network', message });

function setup(send: (text: string) => Promise<MessageResponse>) {
  const translate = vi.fn(send);
  const controller = createTranslateController({ translate, viewport: VIEWPORT });
  return { controller, translate };
}

function trigger(controller: ReturnType<typeof setup>['controller'], text: string) {
  controller.translate(text, ANCHOR);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('翻译控制器：请求生命周期', () => {
  it('发起请求后先显示加载态，响应到达后展示译文', async () => {
    const d = deferred<MessageResponse>();
    const { controller } = setup(() => d.promise);

    trigger(controller, 'Hello');
    expect(textOf('.st-status')).toContain('翻译中');

    d.resolve(ok('你好'));
    await vi.waitFor(() => expect(textOf('.st-translated')).toBe('你好'));
  });

  it('同一文本重复触发不重复请求', async () => {
    const { controller, translate } = setup(() => Promise.resolve(ok('你好')));

    trigger(controller, 'Hello');
    await vi.waitFor(() => expect(textOf('.st-translated')).toBe('你好'));
    trigger(controller, 'Hello');

    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('旧请求响应在选区变更后不渲染（作废）', async () => {
    const first = deferred<MessageResponse>();
    const second = deferred<MessageResponse>();
    const queue = [first.promise, second.promise];
    const { controller } = setup(() => queue.shift() ?? Promise.resolve(ok('?')));

    trigger(controller, 'Hello');
    trigger(controller, 'World');

    // 新请求先返回，旧请求后返回
    second.resolve(ok('世界'));
    await vi.waitFor(() => expect(textOf('.st-translated')).toBe('世界'));

    first.resolve(ok('你好'));
    await Promise.resolve();
    await Promise.resolve();

    expect(textOf('.st-translated')).toBe('世界');
  });

  it('失败时展示错误态，重试重新发起请求', async () => {
    let attempt = 0;
    const { controller, translate } = setup(() => {
      attempt += 1;
      return Promise.resolve(attempt === 1 ? fail('boom') : ok('你好'));
    });

    trigger(controller, 'Hello');
    await vi.waitFor(() => expect(textOf('.st-status')).toContain('网络'));

    const buttons = shadow()?.querySelectorAll('button') ?? [];
    const retry = Array.from(buttons).find((b) => b.textContent === '重试');
    retry?.click();

    await vi.waitFor(() => expect(textOf('.st-translated')).toBe('你好'));
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it('发送异常（消息通道断开）归为错误态而非崩溃', async () => {
    const { controller } = setup(() => Promise.reject(new Error('receiving end does not exist')));

    trigger(controller, 'Hello');

    await vi.waitFor(() => expect(textOf('.st-status')).toContain('翻译失败'));
  });

  it('dismiss 后卡片移除，迟到的响应不再渲染', async () => {
    const d = deferred<MessageResponse>();
    const { controller } = setup(() => d.promise);

    trigger(controller, 'Hello');
    controller.dismiss();

    expect(document.getElementById(CARD_ID)).toBeNull();

    d.resolve(ok('你好'));
    await Promise.resolve();
    await Promise.resolve();
    expect(document.getElementById(CARD_ID)).toBeNull();
  });

  it('destroy 后新请求被忽略', async () => {
    const { controller, translate } = setup(() => Promise.resolve(ok('你好')));

    controller.destroy();
    trigger(controller, 'Hello');

    expect(translate).not.toHaveBeenCalled();
    expect(document.getElementById(CARD_ID)).toBeNull();
  });
});
