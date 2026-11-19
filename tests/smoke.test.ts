import { describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';

/**
 * T1 冒烟测试：验证 vitest + WxtVitest 工具链接线正确。
 * WxtVitest 注入 fake browser 实现，runtime.id 应有值。
 */
describe('工具链冒烟', () => {
  it('fake browser 已注入', () => {
    expect(browser.runtime.id).toBeDefined();
  });
});
