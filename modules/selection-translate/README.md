# selection-translate

划词检测、浮层按钮、译文卡片。运行于 content script。

契约与用法：见任务 T6–T7 交付；模块职责与依赖方向见 `docs/ARCHITECTURE.md`。

## 当前进度

- **T6（已实现）**：选区检测、浮层按钮、门控
- **T7（已实现）**：译文卡片、请求节流与旧请求作废

本模块**不直接发起任何网络请求**。所有翻译经 `@/modules/translation-core` 的消息通道交给 background，大模型 key 永不进入 content script。

## 公开 API

| 导出 | 说明 |
| --- | --- |
| `startSelectionTranslate({ url, translate? })` | 启动划词翻译；返回清理函数。门控不通过时返回空清理函数且不挂任何监听。`translate` 缺省走 background 消息通道 |
| `shouldActivate(url)` | 门控判定：功能开关 + 站点黑名单 + 协议白名单 |
| `extractSelection(selection, { maxLength? })` | 提取选区文本；无选区/折叠/纯空白/超长返回 `null` |
| `getSelectionRect(selection)` | 取选区包围盒；无选区、全零矩形、环境不支持时返回 `null` |
| `createButton({ onClick })` / `positionButton(rect, viewport)` / `removeButton()` | 浮层按钮的创建、定位与移除 |
| `BUTTON_ID` | 浮层宿主元素 id（页面内唯一） |
| `createThrottle(fn, waitMs)` | 尾部节流：等待期内只保留最后一次参数 |
| `createTranslateController({ translate, viewport, targetLanguage? })` | 翻译控制器：发起请求、作废旧响应、管理卡片生命周期。返回 `{ translate(text, rect), dismiss(), destroy() }` |
| `createCard({ onClose, onRetry, targetLanguage? })` | 创建/重置卡片宿主与回调 |
| `renderCard(state, { rect, viewport })` | 按状态渲染并定位卡片 |
| `hideCard()` / `isCardVisible()` | 移除卡片 / 查询是否可见 |
| `errorTextOf(code)` | 错误码 → 用户可见文案 |
| `CARD_ID` | 卡片宿主元素 id（页面内唯一） |

`CardState` 为联合类型：`{ kind: 'loading', source }` / `{ kind: 'success', source, translated, from, engine }` / `{ kind: 'error', source, code?, message? }`。`message` 仅作诊断留存，**卡片只展示错误码映射后的文案**。

## 行为约定

- **门控与实时生效**（任一不满足即不激活）：`features.selectionTranslate` 为 true、站点不在黑名单（含子域）、协议为 http/https、配置读取成功。通过 `watchSettings` 监听配置变更，弹窗或设置页切换开关、增删黑名单或修改目标语言后无需刷新页面立即启停并清理在途浮层
- **选区上限**：默认 5000 字符，超出视为误选整页，不弹出按钮
- **Shadow DOM**：按钮寄生在 `#translation-app-floating-button` 的 open shadow root 内，`all: initial` 隔离页面样式，`z-index` 取最大值
- **定位**：默认贴选区下方居中；视口底部空间不足时翻到选区上方；左右边缘自动收拢，不溢出屏幕
- **节流**：`selectionchange` 与 `scroll` 共用 200ms 尾部节流，拖拽选择时以最终选区为准
- **卡片状态**：点击按钮先出「翻译中…」，成功展示原文 + 译文 + 引擎徽标 + 语言徽标（`from → 目标语言`）与「复制」；失败展示错误文案与「重试」。加载态无重试按钮
- **旧请求作废**：控制器每次请求递增序号，响应到达时序号不匹配即丢弃。快速改选区时「先发后到」的旧响应不会覆盖新卡片
- **重复请求抑制**：同一文本、卡片仍在显示时重复触发不再发请求
- **选区变化收起卡片**：`selectionchange` 产生新选区时先收起旧卡片，避免卡片与选区错位
- **错误文案**：`network` / `rate-limit` / `unsupported-language` / `authentication` / `unknown` 各对应一句用户文案，**不透出** background 返回的原始 `message`（可能含堆栈或接口字段）
- **剪贴板**：复制失败（无权限、`navigator.clipboard` 缺失）静默处理，不影响卡片其余功能
- **卡片定位**：默认贴选区下方（间距 8px）；下方空间不足时翻到上方；左右收拢到视口内。宽度固定 320px，高度按 140px 估算判断空间
- **健壮性**：`getBoundingClientRect` 缺失（旧 WebView、跨域 iframe 选区不可定位）时静默跳过，不抛错

## 测试

| 文件 | 覆盖 |
| --- | --- |
| `selection.test.ts` | 文本提取（空白/折叠/null/超长边界/多行），矩形提取（打桩布局、全零、方法缺失） |
| `gate.test.ts` | 开关、黑名单及子域、非法 URL、特权协议、存储失败降级 |
| `button.test.ts` | 创建/复用/销毁、shadow root 隔离、点击回调、下方定位、上翻、边缘收拢 |
| `throttle.test.ts` | 合并为一次、最后参数生效、cancel、实例隔离 |
| `index.test.ts` | 黑名单与开关不初始化、选区出现与消失、清除选区、iframe 不可定位、清理函数；点击按钮展示译文、缺省消息通道、新选区收起卡片、清理移除卡片 |
| `card.test.ts` | 成功/加载/错误三态渲染、徽标与语言映射、重复渲染复用宿主、关闭/重试/复制回调、剪贴板不可用、下方定位、上翻、边缘收拢、可见性、错误文案映射 |
| `controller.test.ts` | 加载→成功流转、同文本不重复请求、旧响应作废、失败重试、消息通道异常降级、dismiss 后迟到响应不渲染、destroy 后忽略请求 |

## 已知限制

- jsdom 不做布局，`Range.getBoundingClientRect` 恒为 0 且 jsdom 默认不提供该方法；涉及定位的用例通过给 range 实例打桩模拟真实布局
- 浮层按钮位置用固定尺寸估算（80×32），按钮文案变化时需同步调整
- 卡片宽度固定（320px，`card-style.ts`），高度按估算值判断下方空间；卡片实际更高时可能压住选区下一行内容
- 语言徽标直接展示 BCP-47 码（如 `en → zh-CN`），未做母语名本地化
- 滚动时卡片不重定位（仅按钮跟随）；选区滚出视口后卡片需手动关闭或重新选区

## 用法

```ts
import { startSelectionTranslate } from '@/modules/selection-translate';

// content script 入口（entrypoints/selection.content.ts 已接线）
const cleanup = await startSelectionTranslate({ url: location.href });

// 测试或复用场景可注入翻译通道
const stop = await startSelectionTranslate({
  url: 'https://example.com',
  translate: async (text) => ({ ok: true, result: { text: '译文', from: 'en', engine: 'edge' } }),
});
```
