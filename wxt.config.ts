import { defineConfig } from 'wxt';

export default defineConfig({
  // 业务模块目录 modules/ 与 WXT 本地模块目录约定撞名，指向专用空目录避免被当作 WXT 模块加载
  modulesDir: 'wxt-modules',
  manifest: {
    name: 'translationApp',
    description: '网页划词翻译 + YouTube 双语字幕',
    // storage 用于保存配置与缓存（wxt/utils/storage 必需，缺失时读取会一直挂起）
    permissions: ['storage'],
  },
});
