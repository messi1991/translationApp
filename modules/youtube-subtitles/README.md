# youtube-subtitles

YouTube 双语字幕模块：`captionTracks` 选轨与原始音轨语言判定、json3 字幕拉取、MAIN world ↔ isolated world 随机 nonce `postMessage` 桥、SPA 路由跟随、快速切视频防串，以及对接 `subtitle-pipeline` 的端到端双语渲染运行器。运行于 content script（双 world）。

模块职责与依赖方向见 `docs/ARCHITECTURE.md`。MAIN world 脚本与页面共享执行环境，**不引用 `settings`、不接触任何扩展 API 或密钥**；功能开关与黑名单门控均在 isolated world 完成。

## 公开 API

| 导出 | 说明 |
| --- | --- |
| `startYouTubeSubtitles(options?)` | isolated world 顶层入口：串联门控监听（`watchSettings` 实时响应开关/黑名单/语言变化）、桥接字幕源与 `subtitle-pipeline` 双语渲染；直播/Shorts/无字幕/字幕获取失败均展示自动隐藏的提示条并保持原字幕 |
| `startYouTubeSubtitleSource(options)` | 字幕源控制器：监听路由与门控，经桥拉取当前视频字幕并通过 `onStateChange` 推送 `YouTubeSubtitleState`；失败后按 3s/6s/12s 退避自动重试；返回 `{ refresh(), destroy() }` |
| `shouldActivateYouTubeSubtitles(url)` | 门控判定：`features.youtubeSubtitles` 开关 + `blockedHosts` 站点黑名单 + `http(s):` 协议 |
| `startMainWorldBridge(options?)` / `installTimedTextInterceptor()` / `graftSessionParams(baseUrl, donorUrl)` | MAIN world 入口：安装字幕请求横取 hook（幂等）、绑定首次随机 nonce 握手并响应字幕获取请求（`sniffWaitMs` 控制等待播放器 POT 请求的上限）；`graftSessionParams` 把会话参数只补缺地拼进目标 URL |
| `chooseTrack(tracks, options?)` | 按「原语言手动 → 原语言 ASR → 默认手动 → 首条手动 → 兜底 ASR」优先级选出源字幕轨道 |
| `originalAudioLang(formats)` | 从 `streamingData.adaptiveFormats` 的 `xtags`（base64url `original` 标记）或 `audioIsDefault` 解出原始音轨语言 |
| `isAsrTrack(track)` / `normalizeLangTag(code)` | 判断自动生成轨道（`kind === 'asr'` 或 `vssId` 以 `a.` 开头）/ 归一化语言标签（区分 `zh-Hans` 与 `zh-Hant`） |
| `buildJson3Url(baseUrl)` / `parseJson3(payload, { isAsr })` / `fetchJson3Track(baseUrl, options)` | 字符串拼接追加 `fmt=json3`（**不经 `URL`/`URLSearchParams` 重编码，否则签名失效会返回 200 + 空 body**）、解析事件级 `cues` 与 ASR 单词级 `words`、拉取并校验非空 JSON |
| `requestSubtitleText(url, options)` / `parseSubtitleBody(text, { isAsr })` / `parseTranscriptXml(xml)` | 原样请求任意字幕 URL、按内容自动判别 JSON / XML（srv1 `<text start dur>`、srv3 `<p t d><s t>`）、解析 XML 字幕 |
| `createIsolatedBridgeClient(options?)` / `createNonce()` / `readBridgeMessage(...)` / `postBridgeMessage(...)` | 双 world `postMessage` 桥客户端与底层信封收发原语 |
| `classifyYouTubeUrl(url)` / `observeYouTubeNavigation(onUrlChange, options?)` | 解析 `/watch`、`/embed`、`/shorts` 路由；订阅 `yt-navigate-finish` / `yt-page-data-updated` / `popstate` + 1s URL 轮询兜底 |

### 状态类型 `YouTubeSubtitleState`

- `{ kind: 'idle' }`：非观看页或门控未启用
- `{ kind: 'loading', videoId }`：正在等待播放器就绪并拉取当前视频字幕
- `{ kind: 'ready', videoId, languageCode, isAsr, cues, words }`：字幕就绪（手动轨道用 `cues`，ASR 轨道同时提供单词级 `words` 供 `subtitle-pipeline` 重组）
- `{ kind: 'unsupported', reason: 'live' | 'shorts' | 'no-captions', videoId? }`：直播、Shorts 或视频无可用字幕
- `{ kind: 'error', message, videoId? }`：桥握手超时、播放器超时或字幕拉取失败

## 通信与防串约定

- **双脚本 `document_start` 注入**：`entrypoints/youtube-main.content.ts`（`world: 'MAIN'`）与 `entrypoints/youtube.content.ts`（isolated world）均在 `document_start` 启动；isolated 侧用 `crypto.getRandomValues` 生成 128-bit nonce 发送 `hello`，MAIN 侧锁定首条 `hello` 的 nonce，后续仅处理同 `window`、同 `BRIDGE_SOURCE`、方向匹配且 nonce 一致的消息
- **两层切视频防串**：
  1. MAIN world 读取 `#movie_player.getPlayerResponse()`（首屏回退 `window.ytInitialPlayerResponse`）时严格轮询比对 `videoDetails.videoId === expectedVideoId`，避免 SPA 跳转瞬间读到上一条视频残留数据；两份候选都匹配时优先带 `captionTracks` 的那份，播放器早期响应缺字幕时继续轮询至超时而不提前判定无字幕
  2. isolated world 每次路由变化递增 `sessionSeq` 并通过 `AbortController` 向桥发送 `abort-request` 取消在途请求；迟到的旧响应因序号与 `videoId` 双重校验被丢弃

## 用法

```ts
// isolated world（entrypoints/youtube.content.ts）
import { startYouTubeSubtitleSource } from '@/modules/youtube-subtitles';

const source = startYouTubeSubtitleSource({
  onStateChange(state) {
    if (state.kind === 'ready') {
      // state.videoId, state.isAsr, state.cues, state.words
    }
  },
});

// MAIN world（entrypoints/youtube-main.content.ts）
import { startMainWorldBridge } from '@/modules/youtube-subtitles/main-world';
startMainWorldBridge();
```

## 字幕拉取降级链

WEB 客户端的 `captionTracks[].baseUrl` 缺 `pot`（Proof of Origin Token）时会返回 **HTTP 200 + 空 body**，不报错也不给数据，所以单次请求失败不代表视频没字幕。MAIN world 在 `document_start` 就非破坏式横取播放器自己的字幕通信（`fetch` 包一层 `response.clone()`、`XMLHttpRequest.open` 挂 `load`），然后按序取用，任一成功即返回：

1. **横取到的播放器字幕体**（`videoId → 响应原文`，跳过带 `tlang` 的自动翻译轨）—— 播放器渲染原生字幕时一定带着有效 `pot` 请求过同一批数据
2. `baseUrl` + `fmt=json3`，再试 `baseUrl` 原始格式（srv1 / srv3 XML）
3. 等 `sniffWaitMs`（默认 5s）后取播放器那次带 `pot` 的请求 URL，把 `pot`/`c...` 等会话参数**只补缺**地拼到目标 `baseUrl`（不改签名参数）再拉
4. 备用客户端（InnerTube `/youtubei/v1/player`，`ANDROID`）重新取播放器响应 → 重新选轨 → 再走 2、3

全部失败才返回 `{ kind: 'error' }`，错误文案带每次尝试的 `HTTP 状态` 与字节数，isolated world 会把它打到 console 并展示提示条。横取的 hook 带标记幂等，不阻塞播放器自身的字幕渲染。

## 测试

| 文件 | 覆盖 |
| --- | --- |
| `track.test.ts` | ASR 判定、繁简与地区语言码归一化、自动配音 `xtags` 原音轨识别、手动/ASR/自动配音三类选轨优先级 |
| `json3.test.ts` | `fmt=json3` 参数覆盖且签名原始字节不变、手动字幕合并、`aAppend` 与空事件过滤、缺失时长兜底、ASR 单词时间戳展开、srv1/srv3 XML 解析、JSON/XML 自动判别、HTTP 错误与空 body 抛错 |
| `bridge.test.ts` | 随机 nonce 生成、跨窗口/错 tag/错方向/伪造 nonce 拦截、握手收发、无响应超时、`AbortSignal` 中止 |
| `main-world.test.ts` | 首次 `hello` 锁定 nonce 防投毒、播放器残留旧 `videoId` 轮询等待、直播与无字幕分类、`ytInitialPlayerResponse` 首屏回退、播放器响应缺字幕时优先采用带 `captionTracks` 的一份、直接复用横取到的播放器字幕体、借播放器请求里的 POT 重拉目标轨道、json3 空 body 回退 XML、两条候选均空时改走备用客户端、全失败返回带诊断的 error |
| `index.test.ts` | URL 分类（watch / embed / shorts / other）、开关与黑名单门控、`yt-navigate-finish` / `popstate` / 轮询去重、端到端切视频防慢响应串台、失败退避重试后成功 |
| `runtime.test.ts` | 观看页桥接 → pipeline → background 引擎翻译 → Shadow DOM 双语渲染全链路、动态关开关恢复原字幕、Shorts/直播提示条、拉取失败提示条与原字幕保持 |
