import type {
  Provider,
  TranslateInput,
  TranslateManyInput,
  TranslationResult,
} from './provider';
import { TranslationError } from './error';

const ENDPOINT = 'https://edge.microsoft.com/translate/translatetext';
const IS_ENTERPRISE_CLIENT = 'false';
const PROBE_TEXT = 'connection test';

/** BCP-47 → 微软语言码（仅列与微软码不同的项，其余透传） */
const MICROSOFT_LOCALE_MAP: Record<string, string> = {
  'zh-CN': 'zh-Hans',
  'zh-TW': 'zh-Hant',
};

const toMicrosoftLocale = (code: string): string => MICROSOFT_LOCALE_MAP[code] ?? code;

/** 响应条目结构（仅取所需字段） */
interface MicrosoftTranslationEntry {
  translations?: Array<{ text?: string; to?: string }>;
}

/** 将 fetch 层异常分类为统一错误 */
function classifyHttpFailure(status: number): TranslationError {
  if (status === 429) {
    return new TranslationError('rate-limit', `请求过于频繁（HTTP ${status}）`);
  }
  if (status === 400) {
    return new TranslationError('unsupported-language', `不支持的语言对或参数（HTTP ${status}）`);
  }
  return new TranslationError('unknown', `翻译请求失败（HTTP ${status}）`);
}

/** 调用 Edge 免费翻译端点，texts 与响应一一对应 */
async function requestMicrosoft(texts: string[], from: string, to: string): Promise<MicrosoftTranslationEntry[]> {
  const url =
    `${ENDPOINT}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
    `&isEnterpriseClient=${IS_ENTERPRISE_CLIENT}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(texts),
    });
  } catch (cause) {
    throw new TranslationError('network', '网络请求失败', cause);
  }
  if (!response.ok) {
    throw classifyHttpFailure(response.status);
  }
  try {
    const data = (await response.json()) as MicrosoftTranslationEntry[];
    if (!Array.isArray(data)) {
      throw new TranslationError('unknown', '翻译响应格式异常');
    }
    return data;
  } catch (cause) {
    if (cause instanceof TranslationError) throw cause;
    throw new TranslationError('unknown', '翻译响应格式异常', cause);
  }
}

/** 从响应条目取译文，缺失即视为异常响应 */
function entryText(entry: MicrosoftTranslationEntry | undefined): string {
  const text = entry?.translations?.[0]?.text;
  if (typeof text !== 'string') {
    throw new TranslationError('unknown', '翻译响应缺少译文');
  }
  return text;
}

/** 创建 Edge 免费端点引擎实例（仅 background 中使用） */
export function createEdgeProvider(): Provider {
  return {
    engine: 'edge',

    async translate(input: TranslateInput): Promise<TranslationResult> {
      const [entry] = await requestMicrosoft(
        [input.text],
        input.from ?? '',
        toMicrosoftLocale(input.to),
      );
      return { text: entryText(entry), from: input.from ?? 'auto', engine: 'edge' };
    },

    /**
     * 端点本身接受字符串数组并逐条返回，字幕一批 60 条只需一次往返；
     * 未走批量时每次字幕批会退化成 60 次串行请求（实测约 18 秒），译文迟迟不出现。
     */
    async translateMany(input: TranslateManyInput): Promise<TranslationResult[]> {
      if (input.texts.length === 0) return [];
      const entries = await requestMicrosoft(
        input.texts,
        input.from ?? '',
        toMicrosoftLocale(input.to),
      );
      if (entries.length !== input.texts.length) {
        throw new TranslationError('unknown', '翻译响应条数与请求不一致');
      }
      return entries.map((entry) => ({
        text: entryText(entry),
        from: input.from ?? 'auto',
        engine: 'edge' as const,
      }));
    },

    async testConnection(): Promise<void> {
      await requestMicrosoft([PROBE_TEXT], '', 'zh-Hans');
    },
  };
}
