import { getSettings } from './store';

/**
 * 判断主机是否命中黑名单：精确匹配或子域匹配。
 * 入参为主机名（不含协议与路径），列表项也是主机名，如 'github.com'。
 */
export function isHostBlocked(host: string, blockedHosts: string[]): boolean {
  const target = host.toLowerCase().trim();
  return blockedHosts.some((entry) => {
    const blocked = entry.toLowerCase().trim();
    return target === blocked || target.endsWith(`.${blocked}`);
  });
}

/** 判断完整 URL 是否被黑名单拦截（先读配置再判定） */
export async function isBlocked(url: string): Promise<boolean> {
  const { hostname } = new URL(url);
  const settings = await getSettings();
  return isHostBlocked(hostname, settings.blockedHosts);
}
