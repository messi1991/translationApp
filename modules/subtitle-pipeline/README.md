# subtitle-pipeline

平台无关字幕流水线：ASR 单词级字幕重组为可读 cue、位置感知预翻译调度、`requestVideoFrameCallback` 帧级时间同步、播放器内 Shadow DOM 双语叠加渲染。运行于 content script。

模块职责与依赖方向见 `docs/ARCHITECTURE.md`。本模块仅依赖 `translation-core` 的消息客户端（`requestTranslateMany`），**不包含任何 YouTube 专属选择器或协议逻辑**，后续新增 B 站等视频平台只需在源模块传入容器、`<video>` 与字幕数组即可复用。

## 公开 API

| 导出 | 说明 |
| --- | --- |
| `startSubtitlePipeline(options)` | 组装并启动单视频双语字幕会话（重组/归一化 → 批量预翻译调度 → 视频时钟 → Shadow DOM 渲染），返回 `{ cues, setHideNativeSubtitles(hide), destroy() }` |
| `regroupAsrWords(words)` / `displayWidth(text)` | ASR 词序列按宽度（84，CJK 计 2）、时长（7s）、静音间隔（1.3s）、句末/句中标点与 `[Music]` 标签重组为可读 cue，并平滑填补 `< 1.2s` 微小间隙消除闪烁 |
| `normalizeManualCues(cues)` | 手动字幕归一化：合并 250ms 内重复同文、合并 50ms 内同时开口双行字幕、裁剪重叠时长 |
| `planNextBatch(cues, claimed, currentTimeMs)` / `buildCueContexts(cues, indices)` | 位置感知批计划纯函数（lookbehind 3s / horizon 6min / 单批 ≤ 60 条且 ≤ 5000 字符）与前 2 后 1 上下文提取（≤ 200 字符） |
| `createSubtitleScheduler(options)` | 并发上限（默认 2 批）、seek 即时重算与失败冷却重试（`FAILED_RETRY_COOLDOWN_MS` 5s，最多 `MAX_RETRY_ATTEMPTS` 3 次，用尽后仅 seek 重拉）的预翻译调度器 |
| `cueAt(cues, timeMs)` / `startVideoClock(video, onTick)` | 二分查找 + 4 步重叠回溯；`requestVideoFrameCallback`（无支持时回退 `requestAnimationFrame`）+ `seeked/pause/play/ratechange` 同步时钟 |
| `createSubtitleRenderer(options)` | 播放器容器内 Shadow DOM 叠加层（`cqh` 自适应字号）、原平台字幕属性切换隐藏、不支持提示条（`renderNotice`）及 `<video>` 直接全屏时的原生 `TextTrack` 降级 |

## 用法

```ts
import { startSubtitlePipeline } from '@/modules/subtitle-pipeline';

const session = startSubtitlePipeline({
  container: playerElement,
  video: videoElement,
  isAsr: true,
  cues: rawCues,
  words: rawWords,
  from: 'en',
  hideNativeSubtitles: true,
});

// 视频切换或开关关闭时清理（立即移除叠加层并恢复原字幕）
session.destroy();
```

## 测试

| 文件 | 覆盖 |
| --- | --- |
| `regroup.test.ts` | 中日韩字符双倍宽度、句末标点最小宽度阈值、逗号 60% 宽度断句、84 宽上限、7s 时长上限、1.3s 静音切分、`[Applause]` 独立成条、`< 1.2s` 防闪烁延展、手动字幕合并与重叠裁剪 |
| `scheduler.test.ts` | lookbehind 3s / horizon 6min 边界、60 条与 5000 字上限、6 分钟外返回 `null`、前后文裁剪、双并发与 seek 远端即时重算、失败冷却到期自动重试、重试用尽后仅 seek 重拉 |
| `clock.test.ts` | 非重叠与长短重叠 `cueAt` 二分回溯、`requestVideoFrameCallback` 帧推进、暂停保持显示且停止空转、`seeked`/`ratechange` 事件、`requestAnimationFrame` 降级 |
| `renderer.test.ts` | Shadow DOM 原文/双语/空帧切换、原字幕隐藏属性开关与恢复、`renderNotice` 提示条、`<video>` 全屏 `TextTrack` 降级与退出恢复 |
| `index.test.ts` | ASR 重组 → 异步译文补齐刷新 → 帧推进切句 → 暂停驻留 → 销毁清理全链路；翻译失败时提示条展示与自动隐藏 |
