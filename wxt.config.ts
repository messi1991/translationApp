import { defineConfig } from 'wxt';

export default defineConfig({
  // 业务模块目录 modules/ 与 WXT 本地模块目录约定撞名，指向专用空目录避免被当作 WXT 模块加载
  modulesDir: 'wxt-modules',
  manifest: {
    name: 'translationApp',
    description: '网页划词翻译 + YouTube 双语字幕',
    // storage 用于保存配置与缓存；activeTab 仅在用户点击工具栏图标打开 popup 时获取当前站点域名用于快捷拉黑（不申请常驻 tabs 权限）
    permissions: ['storage', 'activeTab'],
  },
});
