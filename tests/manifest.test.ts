import { describe, expect, it } from 'vitest';
import wxtConfigSource from '../wxt.config.ts?raw';

// 产物 manifest 仅在构建后存在；缺失时跳过产物校验（由 pnpm build 负责保证）
const builtManifest = await import('../.output/chrome-mv3/manifest.json?raw').catch(() => null);

/** 设计文档允许的最小权限集合：仅 storage 与点击扩展图标时的临时 activeTab */
const ALLOWED_PERMISSIONS = ['storage', 'activeTab'];

/**
 * manifest 权限最小化与契约守门测试（T1 / T14）。
 *
 * 背景：jsdom + fakeBrowser 不需要真实权限，权限缺失或过度申请在单测里不可见。
 */
describe('manifest 权限最小化契约', () => {
  it("wxt.config.ts 声明了 'storage' 与 'activeTab'，且未声明 host_permissions 或宽泛 tabs 权限", () => {
    expect(wxtConfigSource).toMatch(/permissions\s*:\s*\[[^\]]*['"]storage['"]/);
    expect(wxtConfigSource).toMatch(/permissions\s*:\s*\[[^\]]*['"]activeTab['"]/);
    expect(wxtConfigSource).not.toMatch(/host_permissions/);
    expect(wxtConfigSource).not.toMatch(/['"]tabs['"]/);
    expect(wxtConfigSource).not.toMatch(/['"]<all_urls>['"]/);
  });

  it('构建产物 manifest 权限严格等于最小集合 [storage, activeTab]，无 host_permissions', () => {
    if (!builtManifest) return; // 未构建时跳过
    const manifest = JSON.parse(builtManifest.default) as {
      manifest_version?: number;
      permissions?: string[];
      host_permissions?: string[];
    };
    expect(manifest.manifest_version).toBe(3);
    expect([...(manifest.permissions ?? [])].sort()).toEqual([...ALLOWED_PERMISSIONS].sort());
    expect(manifest.host_permissions).toBeUndefined();
  });
});
