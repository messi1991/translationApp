/** YouTube playerResponse 中的单条字幕轨道描述 */
export interface CaptionTrack {
  languageCode: string;
  baseUrl: string;
  kind?: string;
  vssId?: string;
  isTranslatable?: boolean;
}

/** YouTube adaptiveFormats 中的音轨元信息（用于自动配音场景识别原始音轨语言） */
export interface AudioFormat {
  audioTrack?: {
    id: string;
    audioIsDefault?: boolean;
  };
  xtags?: string;
}

export interface ChooseTrackOptions {
  /** YouTube audioTracks 里声明的 defaultCaptionTrackIndex */
  defaultIndex?: number;
  /** 原始音轨语言码（如 "en-US"），由 originalAudioLang 提取 */
  originalLang?: string;
}

/** 繁体中文常见地区/脚本子标签 */
const TRADITIONAL_ZH_SUBTAGS = new Set(['hant', 'tw', 'hk', 'mo']);

/** 判断字幕轨道是否为自动语音识别（ASR）生成 */
export function isAsrTrack(track: Partial<CaptionTrack>): boolean {
  return track.kind === 'asr' || (track.vssId ?? '').startsWith('a.');
}

/**
 * 归一化语言标签以便对齐同一语言的不同写法：
 * - 中文区分简繁（zh-TW / zh-HK / zh-Hant -> zh-hant，其余 zh* -> zh-hans）
 * - 其余语言取小写主语言子标签（en-US / en_GB -> en）
 */
export function normalizeLangTag(code: string): string {
  const parts = code.trim().toLowerCase().split(/[-_]/).filter(Boolean);
  const primary = parts[0];
  if (!primary) return '';
  if (primary === 'zh') {
    const isHant = parts.slice(1).some((sub) => TRADITIONAL_ZH_SUBTAGS.has(sub));
    return isHant ? 'zh-hant' : 'zh-hans';
  }
  return primary;
}

function decodeBase64Url(input: string): string | null {
  try {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (normalized.length % 4)) % 4;
    return atob(normalized + '='.repeat(padLen));
  } catch {
    return null;
  }
}

function trackLangFromId(id: string): string | undefined {
  const lang = id.split('.')[0]?.trim();
  return lang || undefined;
}

/**
 * 从 adaptiveFormats 提取原始音轨语言码。
 *
 * 自动配音视频存在多条 ASR 字幕，仅靠字幕列表无法得知原语言；
 * 原声流的 xtags（base64url）包含 "original" 标记，其次回退 audioIsDefault。
 */
export function originalAudioLang(formats: readonly AudioFormat[]): string | undefined {
  for (const fmt of formats) {
    if (!fmt.audioTrack?.id || !fmt.xtags) continue;
    const decoded = decodeBase64Url(fmt.xtags);
    if (decoded && decoded.includes('original')) {
      return trackLangFromId(fmt.audioTrack.id);
    }
  }
  for (const fmt of formats) {
    if (fmt.audioTrack?.id && fmt.audioTrack.audioIsDefault) {
      return trackLangFromId(fmt.audioTrack.id);
    }
  }
  return undefined;
}

function pickOriginalAsr(
  asrs: readonly CaptionTrack[],
  manual: readonly CaptionTrack[],
  originalLang?: string,
): CaptionTrack | undefined {
  if (originalLang) {
    const target = normalizeLangTag(originalLang);
    return asrs.find((t) => normalizeLangTag(t.languageCode) === target);
  }
  if (asrs.length > 1) {
    return (
      asrs.find((t) =>
        manual.some((m) => normalizeLangTag(m.languageCode) === normalizeLangTag(t.languageCode)),
      ) ?? asrs[0]
    );
  }
  return asrs[0];
}

/**
 * 从 captionTracks 选出待翻译的源字幕轨道：
 * 1. 原语言手动字幕（精确匹配优先，归一化匹配次之）
 * 2. 原语言 ASR 自动字幕
 * 3. 默认手动轨道 -> 首条手动轨道 -> 兜底 ASR
 */
export function chooseTrack(
  tracks: readonly CaptionTrack[],
  options: ChooseTrackOptions = {},
): CaptionTrack | null {
  if (tracks.length === 0) return null;

  const manual = tracks.filter((t) => !isAsrTrack(t));
  const asrs = tracks.filter((t) => isAsrTrack(t));
  const asr = pickOriginalAsr(asrs, manual, options.originalLang);
  const def = options.defaultIndex !== undefined ? tracks[options.defaultIndex] : undefined;

  const original =
    options.originalLang ??
    asr?.languageCode ??
    (def && !isAsrTrack(def) ? def.languageCode : undefined);

  if (original) {
    const exact = manual.find((t) => t.languageCode.toLowerCase() === original.toLowerCase());
    if (exact) return exact;
    const norm = normalizeLangTag(original);
    const matchedManual = manual.find((t) => normalizeLangTag(t.languageCode) === norm);
    if (matchedManual) return matchedManual;
    if (asr) return asr;
  }

  if (def && !isAsrTrack(def)) return def;
  return manual[0] ?? asr ?? asrs[0] ?? null;
}
