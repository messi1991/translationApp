import { getSettings, isHostBlocked } from '@/modules/settings';

/** 允许注入 UI 的协议；chrome://、about: 等特权页无法注入也不能注入 */
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * 判断当前页面是否应激活划词翻译。
 *
 * 任一条件不满足即不激活：功能开关关闭、站点命中黑名单、非法 URL、
 * 非 http(s) 协议、读取配置失败（宁可不打扰用户，也不弹错）。
 */
export async function shouldActivate(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    return false;
  }

  try {
    const settings = await getSettings();
    if (!settings.features.selectionTranslate) {
      return false;
    }
    return !isHostBlocked(parsed.hostname, settings.blockedHosts);
  } catch {
    return false;
  }
}
