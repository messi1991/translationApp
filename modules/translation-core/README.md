# translation-core

统一 `translate()` 接口与引擎实现（Edge 端点、OpenAI 兼容）、翻译结果二级缓存、限流退避。运行于 background，经消息对外暴露。

模块职责与依赖方向见 `docs/ARCHITECTURE.md`。**所有翻译 API 请求只从 background 发出**，引擎配置（含 key）只在 background 读取。

## 公开 API

| 导出 | 说明 |
| --- | --- |
| `Provider` | 引擎接口：`translate(input)` / `testConnection()`，`engine` 字段标识引擎 |
| `TranslateInput` | `{ text, to, from? }`；`from` 缺省时由引擎自动识别语言 |
| `TranslationResult` | `{ text, from, engine }`；未指定源语言时 `from` 为 `'auto'` |
| `TranslationError` | 统一错误类，`code` + `message` + `cause` |
| `TRANSLATION_ERROR_CODES` | 错误码常量数组：`network` / `rate-limit` / `unsupported-language` / `authentication` / `unknown` |
| `TranslationErrorCode` | 上述错误码联合类型 |
| `createEdgeProvider()` | 创建 Edge 免费端点引擎实例 |
| `registerTranslateHandler()` | background 注册消息处理，返回解绑函数 |
| `requestTranslate(data)` | content/popup 侧：请求翻译 |
| `requestTestConnection(data)` | options 侧：测试当前引擎连通性 |

## 消息协议

原生 `browser.runtime` 消息，信封格式 `{ type, data }`：

| type | data | 用途 |
| --- | --- | --- |
| `translate` | `{ text, to?, from? }` | 翻译；`to` 缺省取 `settings.targetLanguage` |
| `test-connection` | `{ engine? }` | 连通性测试；`engine` 缺省取 `settings.engine` |

响应统一为信封，**错误不抛异常而是以码透传**：

```ts
type MessageResponse =
  | { ok: true; result: TranslationResult }
  | { ok: false; code: TranslationErrorCode; message: string };
```

background 监听器采用回调式协议（`sendResponse` + 返回 `true`），兼容 MV3 与测试环境。

## 引擎：Edge 免费端点

- 端点：`POST https://edge.microsoft.com/translate/translatetext`
- 免鉴权（2026 版协议；旧 `edge.microsoft.com/translate/auth` 取 token 流程已失效）
- Query：`from`（留空自动检测）、`to`、`isEnterpriseClient=false`
- Body：`string[]`，响应与输入顺序一一对应，取 `translations[].text`
- 语言码映射：`zh-CN → zh-Hans`、`zh-TW → zh-Hant`，其余透传

## 错误映射

| 情形 | 错误码 |
| --- | --- |
| `fetch` reject（断网、DNS、CORS 失败） | `network` |
| HTTP 429 | `rate-limit` |
| HTTP 400 | `unsupported-language` |
| 其他非 2xx / 响应格式异常 / 缺译文或引擎未接入 | `unknown` |

`testConnection()` 失败时抛 `TranslationError`，不静默吞错。

## 已知限制

- OpenAI 兼容引擎尚未接入（T4），消息层对其返回 `unknown` 并附「尚未接入」说明，不崩溃
- 缓存（T5）与限流退避（T13）尚未实现，当前每次请求直连引擎

## 用法

```ts
// background（entrypoints/background.ts 已接线）
import { registerTranslateHandler } from '@/modules/translation-core';
registerTranslateHandler();

// content script：请求翻译
import { requestTranslate } from '@/modules/translation-core';
const res = await requestTranslate({ text: 'Hello' });
if (res.ok) show(res.result.text);
else showError(res.code, res.message);
```

## 测试

`pnpm test` 中本模块用例（`fetch` 全局存根，无网络）：

- `error.test.ts`：错误码枚举与 `TranslationError` 字段
- `edge.test.ts`：成功 / 429 / 网络错误 / 不支持语言对（四分支）+ 语言码映射 + 响应异常 + `testConnection`
- `messaging.test.ts`：消息往返、`to/from` 优先级、错误透传、未接入引擎兜底、连通性测试
