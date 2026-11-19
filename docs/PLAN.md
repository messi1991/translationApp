# translationApp — 产品与技术决策

一个 Chrome 扩展：网页划词翻译 + YouTube 双语字幕，翻译引擎多源可切换，用户自带大模型 key，无自有后端。

## 为什么做

- 现有头部产品不可复用：沉浸式翻译 2023 年停止开源且商业化；kiss-translator 为 GPL-3.0，代码不可引用
- 免费翻译 API 格局 2026 年已变：Google 非官方端点 `translate_a/single` 大面积 429 疑似下线，依赖单一免费端点的插件成批失效，需要一个引擎可插拔的新实现
- 大模型翻译质量上限高于传统引擎，且 OpenAI 兼容接口已成事实标准，用户自带 key 即可用

## 选什么

| 决策点 | 选择 | 理由 |
| --- | --- | --- |
| 形态 | Chrome 扩展（Manifest V3） | 需求方指定；划词与字幕都依赖 content script |
| 框架 | WXT + React + TypeScript | WXT 是 2025–2026 唯一活跃维护的扩展框架；内置 Shadow DOM UI、存储封装、i18n、HMR、上架打包；Plasmo/CRXJS 均停滞 |
| 翻译引擎 | Provider 抽象 + MVP 内置两种：Edge 端点（默认免费）、OpenAI 兼容大模型（用户自配 key + base URL） | Edge 端点免费未限流；OpenAI 兼容接口一个实现覆盖 OpenAI/DeepSeek/Moonshot/Gemini 等 |
| 划词翻译 | `selectionchange` 监听 + 浮层按钮 + Shadow DOM 译文卡片 | 选中即弹按钮、点击才翻译：避免误触发与无谓 API 消耗 |
| 字幕翻译 | 读取 `captionTracks` 选轨 → MAIN world 脚本 + nonce 校验 postMessage 桥 → ASR 单词级字幕重组为 cue → 按播放位置预翻译 → `requestVideoFrameCallback` 同步渲染 | 参照 Taiyaku（2026-10）公开实现路径；不做 xhook 拦截改写响应的侵入式方案 |
| 数据 | 全部存本地 `chrome.storage`（WXT storage 封装）；翻译结果带内存/本地二级缓存 | MV3 禁止远程托管代码，key 无法隐藏，用户自带 key 存本地是同类通行做法；无账号体系 |
| 后端 | 无 | 扩展 background 无 CORS 限制，MVP 引擎均可直连；零部署成本 |

## 不做什么（一期明确排除）

- 整页双语翻译（DOM 段落切分 + 滚动懒加载 + SPA 适配，工作量大）→ 二期
- YouTube 以外的视频平台字幕（B 站、Netflix 等）→ 二期按平台逐个适配
- DeepL：无 CORS，必须自有后端；且 API Free 已不对新用户开放
- Firefox / Safari 发布：WXT 天然跨浏览器，但一期不投入适配测试
- 账号体系、云同步、共享代理服务端
- 生词本、词典查询等语言学习功能
- 实时语音翻译、PDF 翻译

## 阶段划分

开发顺序与任务拆解见 `docs/TODO.md`，此处只定阶段边界。

1. **骨架与引擎层** — WXT 项目初始化；统一 `translate()` 的 Provider 接口；Edge 引擎与 OpenAI 兼容引擎；设置页（目标语言、引擎选择、key/base URL 配置、连通性测试）
2. **划词翻译** — 文本选中检测、浮层按钮、译文卡片、批量/节流、缓存、错误提示
3. **YouTube 字幕** — 轨道选择与语言判定、MAIN world 桥、ASR 重组、位置感知预翻译调度、双语同步渲染、SPA 路由跟随
4. **打磨与上架** — 弹窗快捷开关、黑名单站点、异常兜底、`wxt zip` 打包、商店材料与隐私声明、回归测试

## 风险

- Edge / Chrome 内置免费端点无 SLA，可能随时限流或下线 → 引擎抽象层让新增/切换引擎只改一个模块；大模型引擎作为质量与可用性兜底
- YouTube 播放器内部结构变化会破坏字幕功能（依赖 `captionTracks`、`yt-navigate-finish` 等非公开约定）→ 隔离在字幕模块内部，失败时静默降级并提示
- 浏览器直连大模型 API 暴露 key 给页面级网络面板 → 仅 background 发请求，key 不进入 content script

## 参考来源

- [WXT 官方框架对比](https://wxt.dev/guide/resources/compare.html)
- [免费翻译 API 2026-10 实测（8 家，CORS/额度）](https://cors.dev/guides/free-translation-api)
- [Google 免费端点 429 事件](https://linux.do/t/topic/2804605)
- [Taiyaku 双语字幕实现详解](https://zenn.dev/taiyakujp/articles/9bc1032289e3b4)
- [YouTube 双字幕拦截式旧方案](https://denghao.me/index.php/archives/youtube-dual-subtitles.html)
- [kiss-translator（GPL-3.0，仅借鉴设计）](https://github.com/fishjar/kiss-translator)
