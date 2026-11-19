# translationApp — 任务队列

开发顺序以此文件为准（PLAN 只定阶段）。状态：`未开始 / 进行中 / 待审 / 完成 / 打回`。

## 阶段一：骨架与引擎层

- T1 项目骨架
  - 状态：完成
  - 交付物：WXT + React + TS 初始化；background / popup / options / content script 占位入口；按 `docs/ARCHITECTURE.md` 建模块目录；vitest + eslint 接入
  - 验收：`pnpm dev` 加载扩展成功且 popup 可打开；`pnpm build` 与 `pnpm zip` 产出可安装包；`pnpm test` 通过冒烟用例
  - 前置：无
- T2 settings 模块
  - 状态：完成
  - 交付物：storage schema（目标语言、引擎、key/base URL、功能开关、黑名单）、读写与 `isBlocked(url)` API、设置页 UI、模块 README、单元测试
  - 验收：设置页修改语言/引擎/key 后重开页面值保留；单测断言黑名单内 URL `isBlocked` 为 true、外为 false
  - 前置：T1
- T3 translation-core：接口 + Edge 引擎
  - 状态：完成
  - 交付物：Provider 接口（`translate` / `testConnection`、错误分类）、Edge 端点实现（仅 background 发请求）、background 统一翻译消息、模块 README、fetch mock 单元测试
  - 验收：`pnpm test` 覆盖成功/429/网络错误/不支持语言对四分支；content 侧发消息能拿到译文
  - 前置：T1
- T4 translation-core：OpenAI 兼容引擎
  - 状态：进行中
  - 交付物：OpenAI 兼容 chat completions 实现（自定义 base URL / model / key）、批量合并请求、设置页「测试连接」按钮、单元测试补齐
  - 验收：mock 单测覆盖流式失败/超时/鉴权失败；填入真实 key 点「测试连接」显示成功
  - 前置：T2、T3
- T5 translation-core：翻译缓存
  - 状态：未开始
  - 交付物：内存 LRU + storage 二级缓存装饰器，键含引擎/语言对/文本；单元测试
  - 验收：单测断言同键第二次调用不触发网络请求（mock fetch 计数为 1）；清除设置后缓存失效
  - 前置：T3

## 阶段二：划词翻译

- T6 selection-translate：检测与浮层按钮
  - 状态：未开始
  - 交付物：`selectionchange` 节流检测、WXT Shadow DOM 浮层按钮、选区定位、黑名单跳过、模块 README、单元测试
  - 验收：普通页面选中文本出现按钮；单测断言黑名单站点不初始化 UI；iframe 选区不崩溃
  - 前置：T2、T5
- T7 selection-translate：译文卡片
  - 状态：未开始
  - 交付物：卡片 UI（原文/译文/引擎与语言徽标/复制/错误态/重试）、请求节流与旧请求作废、单元测试
  - 验收：选英文出中文译文；mock 延迟时快速改选区，旧响应不渲染；断网显示错误态且重试按钮可用
  - 前置：T6

## 阶段三：YouTube 字幕

- T8 youtube-subtitles：字幕获取层
  - 状态：未开始
  - 交付物：MAIN world 脚本 + nonce postMessage 桥、captionTracks 选轨与原始音轨语言判定、json3 字幕拉取、`yt-navigate-finish` 路由跟随、视频切换防串、模块 README、选轨单元测试
  - 验收：单测覆盖手动/ASR/自动配音三类轨道选择；真实 YouTube 页面桥接拿到 cue 数组且切视频后 videoId 一致
  - 前置：T4
- T9 subtitle-pipeline：重组与预翻译调度
  - 状态：未开始
  - 交付物：ASR 单词级字幕重组 cue（宽度/时长/静音/标点规则）、位置感知批量调度（lookbehind 3s / horizon 6min / 60 条每批 / 前后文上下文）、seek 重算、模块 README、单元测试
  - 验收：单测断言给定词序列重组结果与规则一致；给定 cues + 播放时间，批计划不超出 horizon 且不含已翻条目
  - 前置：T5
- T10 subtitle-pipeline：同步渲染
  - 状态：未开始
  - 交付物：`requestVideoFrameCallback` 时钟、二分查找当前 cue、播放器内 Shadow DOM 叠加、原字幕隐藏开关、全屏/变速/暂停处理、单元测试
  - 验收：单测断言重叠 cue 下 `cueAt` 返回正确条目；真实视频播放译文随时间切换，全屏与 2 倍速下不漂移，暂停显示不消失
  - 前置：T8、T9
- T11 YouTube 端到端串联
  - 状态：未开始
  - 交付物：YouTube content script 组装（页面检测 → 开关判定 → 桥 → pipeline → 渲染）、开关生效、直播/Shorts 显示不支持提示、失败静默降级
  - 验收：真实视频开启后出现双语字幕；关闭开关恢复原字幕；Shorts 页显示提示条且不报错
  - 前置：T10

## 阶段四：打磨与上架

- T12 popup 工具栏弹窗
  - 状态：未开始
  - 交付物：划词/字幕快捷开关（全局 + 当前站点）、当前引擎显示、设置入口、模块 README、开关状态映射单元测试
  - 验收：弹窗切换划词开关后目标页面立即生效（无需刷新）；当前站点开关写入黑名单
  - 前置：T7、T11
- T13 限流退避与错误文案
  - 状态：未开始
  - 交付物：引擎层统一退避（429 指数退避、并发上限、请求队列）、用户可见错误文案表、单元测试
  - 验收：单测断言连续 429 时重试间隔递增且不超过上限；所有错误态 UI 文案无堆栈/无内部字段
  - 前置：T4
- T14 安全与回归测试（收口）
  - 状态：未开始
  - 交付物：回归用例集（划词/字幕/设置/缓存/黑名单全链路）、key 不进 content script 检查、manifest 权限最小化核对、上架材料（隐私声明、商店截图与描述）
  - 验收：用例集清单逐条通过；产物在干净 Chrome profile 经 `pnpm zip` 安装后划词与字幕全流程可用；manifest 权限清单与设计文档一致
  - 前置：T12、T13
