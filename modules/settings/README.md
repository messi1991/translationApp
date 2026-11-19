# settings

用户配置存取与站点黑名单判定。纯数据模块，不依赖任何业务模块；运行于任意端（options 页、background、content script）。

## 公开 API

| 导出 | 说明 |
| --- | --- |
| `Settings` | 配置类型：目标语言、引擎、各引擎配置、功能开关、`blockedHosts` |
| `DEFAULT_SETTINGS` | 默认配置（目标语言 `zh-CN`，引擎 `edge`，功能全开，黑名单空） |
| `TARGET_LANGUAGES` | 目标语言候选列表（设置页下拉） |
| `getSettings()` | 读取完整配置；无值时返回默认配置，**残缺字段用默认值逐层补齐** |
| `saveSettings(next)` | 全量写入；调用方基于 `getSettings()` 返回值修改后写回 |
| `isHostBlocked(host, blockedHosts)` | 纯函数：主机名是否命中黑名单（精确或子域匹配，大小写不敏感） |
| `isBlocked(url)` | 读配置后判定完整 URL 是否被拦截 |

## 存储契约

- 键：`local:settings`，整对象存储，`fallback` 为 `DEFAULT_SETTINGS`
- `getSettings()` 读取时会用 `DEFAULT_SETTINGS` 逐层补齐缺失字段：`fallback` 只在**整键缺失**时生效，旧版本写入的残缺对象（如新增字段前的存档）会被原样返回，故补一层深合并兜底
- 写入方仅 options 页（与 T12 的 popup）；其余端只读
- 新增字段时必须在 `DEFAULT_SETTINGS` 补默认值，旧存档该字段自动取默认值

## 异常

- `isBlocked(url)`：URL 非法时 `new URL` 抛 `TypeError`（调用方保证传入合法 URL）
- `getValue/setValue` 失败时透传 `@wxt-dev/storage` 的异常

## 用法

```ts
import { getSettings, saveSettings, isBlocked } from '@/modules/settings';

const settings = await getSettings();
if (settings.features.selectionTranslate && !(await isBlocked(location.href))) {
  // 启用划词翻译
}
```

设置页入口：`entrypoints/options/`（扩展详情页 → 「扩展选项」）。

## 测试

- `store.test.ts`：默认值、读写往返、功能开关、旧版残缺配置补齐
- `blocklist.test.ts`：精确/子域/相似前缀/大小写、读配置判定
- `entrypoints/options/App.test.tsx`：设置页改语言 / 改引擎与 key / 加黑名单后保存，重新挂载仍保留（覆盖「重开页面值保留」验收）
