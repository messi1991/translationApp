# translation-core

统一 `translate()` 接口与引擎实现（Edge 端点、OpenAI 兼容）、翻译结果二级缓存、限流退避。运行于 background，经消息对外暴露。

模块职责与依赖方向见 `docs/ARCHITECTURE.md`。**所有翻译 API 请求只从 background 发出**，引擎配置（含 key）只在 background 读取。

## 公开 API

| 导出 | 说明 |
| --- | --- |
| `Provider` | 引擎接口：`translate(input)` / `translateMany?(input)` / `testConnection()`，`engine` 字段标识引擎 |
| `TranslateInput` | `{ text, to, from? }`；`from` 缺省时由引擎自动识别语言 |
| `TranslationResult` | `{ text, from, engine }`；未指定源语言时 `from` 为 `'auto'` |
| `TranslateManyInput` | `{ texts, to, from? }`；批量翻译入参 |
| `TranslationError` | 统一错误类，`code` + `message` + `cause` |
| `TRANSLATION_ERROR_CODES` | 错误码常量数组：`network` / `rate-limit` / `unsupported-language` / `authentication` / `unknown` |
| `TranslationErrorCode` | 上述错误码联合类型 |
| `createEdgeProvider()` | 创建 Edge 免费端点引擎实例 |
| `createOpenAiProvider(config)` | 创建 OpenAI 兼容引擎实例；`config` 为 `{ baseUrl, apiKey, model, timeoutMs? }` |
| `translateBatch(provider, input)` | 统一批量入口：引擎支持 `translateMany` 则合并请求，否则逐条串行 |
| `withCache(provider, options?)` | 给引擎套二级缓存（内存 LRU + storage），返回同接口 Provider |
| `clearCache({ persistent? })` | 清空内存层；`persistent: true` 时连同 storage 一并清除 |
| `Lru` / `keyPartsOf` / `serializeKey` | 缓存内部原语（键构造与 LRU），一般无需直接调用 |
| `registerTranslateHandler()` | background 注册消息处理，返回解绑函数 |
| `requestTranslate(data)` | content/popup 侧：请求翻译 |
| `requestTranslateMany(data)` | 字幕场景：批量翻译，返回 `BatchResponse` |
| `requestTestConnection(data)` | options 侧：测试当前引擎连通性 |

## 消息协议

原生 `browser.runtime` 消息，信封格式 `{ type, data }`：

| type | data | 用途 |
| --- | --- | --- |
| `translate` | `{ text, to?, from? }` | 翻译；`to` 缺省取 `settings.targetLanguage` |
| `translate-many` | `{ texts, to?, from? }` | 批量翻译；返回 `{ ok, result: TranslationResult[] }` |
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

## 引擎：OpenAI 兼容

- 端点：`{baseUrl}/chat/completions`（自动去掉 baseUrl 末尾斜杠）
- 请求：`{ model, messages: [system, user], stream: false, temperature: 0 }`
- 鉴权：`Authorization: Bearer {apiKey}`
- 单条翻译：system 提示指定目标（与可选源）语言，要求只输出译文
- 批量翻译：system 提示要求返回与输入等长的 **JSON 字符串数组**，容忍被 ` ```json ` 代码块包裹；条数不符即报错，不做静默补位
- 默认超时 30s（`timeoutMs` 可覆盖），超时经 `AbortController` 中断并归为 `network` 且文案含「超时」

## 翻译缓存

`createConfiguredProvider` 统一在消息层出口包装缓存，划词与字幕自动受益。

- **两级**：内存 LRU（默认 200 条，进程内）→ `storage.local`（默认 500 条，跨会话）
- **键**：`引擎 + 目标语言 + 源语言（缺省 auto）+ 归一化文本` 四段拼接（用不可见字符 NUL 分隔，避免拼串歧义）。文本去掉首尾空白并合并连续空白；显式 `from` 与缺省 `auto` 视为不同键
- **不缓存**：空文本（直接透传引擎）、空译文、任何抛错的结果——失败的请求重试一定真发
- **失效**：换引擎/换语言对天然换键；`clearCache({ persistent: true })` 全清；storage 条目损坏时按未命中处理
- **降级**：storage 读取或写入异常一律吞掉，退化为纯内存缓存，不影响翻译可用性

## 错误映射

| 情形 | 错误码 |
| --- | --- |
| `fetch` reject（断网、DNS、CORS 失败）、请求超时 | `network` |
| HTTP 429 | `rate-limit` |
| HTTP 401 / 403，或未配置 `apiKey` | `authentication` |
| HTTP 400（Edge 的语言对不支持） | `unsupported-language` |
| 其他非 2xx / 响应非 JSON（含流式 SSE 误返回）/ 缺译文 / 批量条数不符 / 必填配置缺失 | `unknown` |

配置校验在发请求前完成：`apiKey` 缺失优先报 `authentication`，其次 `baseUrl`、`model` 缺失报 `unknown`。

`testConnection()` 失败时抛 `TranslationError`，不静默吞错。

## 已知限制

- 未实现流式输出（`stream: false`）；若上游强制返回 SSE，会以 `unknown` 报错而非崩溃
- 限流退避（T13）尚未实现；当前 429 直接报错，无自动重试

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
- `openai.test.ts`：请求构造、鉴权头、源语言提示、401/403/429/网络/超时/非 JSON/空 choices/SSE 误返回、配置缺失、`testConnection`
- `openai-batch.test.ts`：批量合并、顺序、空数组、条数不符、代码块包裹
- `messaging.test.ts`：消息往返、`to/from` 优先级、错误透传、openai 引擎接线、未配置 key、连通性测试
- `messaging-batch.test.ts`：批量通道、edge 逐条 fallback、目标语言缺省、错误透传
- `cache.test.ts`：命中、键隔离（语言/引擎/空白）、不缓存空值与错误、二级 storage、损坏容错、LRU 逐出
- `cache-messaging.test.ts`：消息层命中生效、换语言与清缓存后重新请求、失败不入缓存
