import { browser } from 'wxt/browser';

/**
 * 查询当前窗口激活标签页的 URL。
 * 注意：仅拥有 activeTab / tabs 权限时 tab.url 有值；无权限或特权页面返回 undefined，不抛异常。
 */
export async function queryActiveTabUrl(): Promise<string | undefined> {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.url;
  } catch {
    return undefined;
  }
}

/** 打开扩展设置页（Options） */
export async function openExtensionOptions(): Promise<void> {
  if (typeof browser.runtime.openOptionsPage === 'function') {
    await browser.runtime.openOptionsPage();
    return;
  }
  const url = browser.runtime.getURL('/options.html');
  window.open(url, '_blank');
}
