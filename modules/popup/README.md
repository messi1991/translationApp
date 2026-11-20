# popup

工具栏弹窗业务模块：将 `settings` 与当前活动标签页 URL 映射为弹窗展示状态，提供全局功能开关（划词翻译 / YouTube 双语字幕）、当前站点快捷拉黑/恢复与设置页跳转。运行于 popup。

模块职责与依赖方向见 `docs/ARCHITECTURE.md`。本模块仅依赖 `settings`，不直接接触翻译引擎配置细节或缓存。

## 公开 API

| 导出 | 说明 |
| --- | --- |
| `extractSiteHost(tabUrl)` | 从标签页 URL 提取小写 `http/https` 主机名；`chrome://` 等特权页面返回 `null` |
| `derivePopupViewModel(settings, activeTabUrl?)` | 生成弹窗视图模型（开关状态、引擎名称与就绪态、目标语言名、当前站点启用态及命中的黑名单规则） |
| `toggleFeatureSwitch(settings, feature, enabled)` | 切换 `selectionTranslate` 或 `youtubeSubtitles` 全局开关并返回新配置 |
| `toggleSiteEnabled(settings, host, enabled)` | 切换当前站点启用状态（禁用写入 `blockedHosts`，启用移除精确匹配及覆盖当前子域的父域黑名单项） |
| `queryActiveTabUrl()` / `openExtensionOptions()` | 查询当前窗口活动标签页 URL（依赖点击扩展图标触发的 `activeTab` 权限）与打开设置页 |

## 实时生效机制

弹窗内每次切换开关都会立即调用 `saveSettings` 写入 `local:settings`；页面内的 `selection-translate` 与 `youtube-subtitles` 均通过 `watchSettings` 订阅变更，无需刷新页面即可立即启停并清理或挂载 UI。

## 权限说明

在用户点击工具栏图标打开 popup 时，Chrome MV3 通过 `activeTab` 权限向弹窗授予当前活动标签页的 URL 读取能力（无需申请宽泛的 `tabs` 常驻浏览记录权限）。若处于 `chrome://` 等浏览器特权页，弹窗展示「当前浏览器内置页不支持注入翻译脚本」。

## 测试

- `modules/popup/state.test.ts`：主机名解析、引擎与语言状态映射、子域命中黑名单提示、全局开关与站点黑名单纯函数变换
- `entrypoints/popup/App.test.tsx`：弹窗渲染、设置页跳转、当前站点写入/移出黑名单、切换划词开关后目标页面无需刷新立即生效
