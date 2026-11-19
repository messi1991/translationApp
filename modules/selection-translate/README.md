# selection-translate

划词检测、浮层按钮、译文卡片。运行于 content script。

契约与用法：见任务 T6–T7 交付；模块职责与依赖方向见 `docs/ARCHITECTURE.md`。

## 当前进度

- **T6（已实现）**：选区检测、浮层按钮、门控
- **T7（未开始）**：译文卡片、请求节流与旧请求作废

本模块**不发起任何网络请求**。所有翻译经 `@/modules/translation-core` 的消息通道交给 background，大模型 key 永不进入 content script。

## 公开 API

| 导出 | 说明 |
| --- | --- |
| `startSelectionTranslate({ url, onTranslate? })` | 启动划词翻译；返回清理函数。门控不通过时返回空清理函数且不挂任何监听 |
| `shouldActivate(url)` | 门控判定：功能开关 + 站点黑名单 + 协议白名单 |
| `extractSelection(selection, { maxLength? })` | 提取选区文本；无选区/折叠/纯空白/超长返回 `null` |
| `getSelectionRect(selection)` | 取选区包围盒；无选区、全零矩形、环境不支持时返回 `null` |
| `createButton({ onClick })` / `positionButton(rect, viewport)` / `removeButton()` | 浮层按钮的创建、定位与移除 |
| `BUTTON_ID` | 浮层宿主元素 id（页面内唯一） |
| `createThrottle(fn, waitMs)` | 尾部节流：等待期内只保留最后一次参数 |

## 行为约定

- **门控**（任一不满足即不激活）：`features.selectionTranslate` 为 true、站点不在黑名单（含子域）、协议为 http/https、配置读取成功。配置读取失败时**不激活**——宁可不打扰，也不弹错
- **选区上限**：默认 5000 字符，超出视为误选整页，不弹出按钮
- **Shadow DOM**：按钮寄生在 `#translation-app-floating-button` 的 open shadow root 内，`all: initial` 隔离页面样式，`z-index` 取最大值
- **定位**：默认贴选区下方居中；视口底部空间不足时翻到选区上方；左右边缘自动收拢，不溢出屏幕
- **节流**：`selectionchange` 与 `scroll` 共用 200ms 尾部节流，拖拽选择时以最终选区为准
- **健壮性**：`getBoundingClientRect` 缺失（旧 WebView、跨域 iframe 选区不可定位）时静默跳过，不抛错

## 测试

| 文件 | 覆盖 |
| --- | --- |
| `selection.test.ts` | 文本提取（空白/折叠/null/超长边界/多行），矩形提取（打桩布局、全零、方法缺失） |
| `gate.test.ts` | 开关、黑名单及子域、非法 URL、特权协议、存储失败降级 |
| `button.test.ts` | 创建/复用/销毁、shadow root 隔离、点击回调、下方定位、上翻、边缘收拢 |
| `throttle.test.ts` | 合并为一次、最后参数生效、cancel、实例隔离 |
| `index.test.ts` | 黑名单与开关不初始化、选区出现与消失、清除选区、iframe 不可定位、清理函数 |

## 已知限制

- jsdom 不做布局，`Range.getBoundingClientRect` 恒为 0 且 jsdom 默认不提供该方法；涉及定位的用例通过给 range 实例打桩模拟真实布局
- 浮层按钮位置用固定尺寸估算（80×32），按钮文案变化时需同步调整
- 点击按钮目前只输出调试日志，译文卡片待 T7 接入
