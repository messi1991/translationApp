import type { Provider, TranslateInput, TranslationResult } from './provider';
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
      const text = entry?.translations?.[0]?.text;
      if (typeof text !== 'string') {
        throw new TranslationError('unknown', '翻译响应缺少译文');
      }
      return { text, from: input.from ?? 'auto', engine: 'edge' };
    },

    async testConnection(): Promise<void> {
      await requestMicrosoft([PROBE_TEXT], '', 'zh-Hans');
    },
  };
}
