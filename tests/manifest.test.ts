import { describe, expect, it } from 'vitest';
import wxtConfigSource from '../wxt.config.ts?raw';

// 产物 manifest 仅在构建后存在；缺失时跳过产物校验（由 pnpm build 负责保证）
const builtManifest = await import('../.output/chrome-mv3/manifest.json?raw').catch(() => null);

/**
 * manifest 权限的守门测试。
 *
 * 背景：jsdom + fakeBrowser 不需要真实权限，权限缺失在单测里完全不可见。
 * 曾因 manifest 缺 'storage'，设置页读取配置时永久停在「加载中」。
 */
describe('manifest 权限契约', () => {
  it("wxt.config.ts 声明了 'storage' 权限", () => {
    expect(wxtConfigSource).toMatch(/permissions\s*:\s*\[[^\]]*['"]storage['"]/);
  });

  it('构建产物 manifest 包含 storage 权限', () => {
    if (!builtManifest) return; // 未构建时跳过
    const manifest = JSON.parse(builtManifest.default) as { permissions?: string[] };
    expect(manifest.permissions).toContain('storage');
  });
});
