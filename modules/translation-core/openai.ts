import type { Provider, TranslateInput, TranslateManyInput, TranslationResult } from './provider';
import { TranslationError } from './error';
import {
  requestChatCompletion,
  type ChatMessage,
  type OpenAiRequestConfig,
} from './openai-request';

const ENGINE = 'openai-compatible';
const PROBE_TEXT = 'connection test';

/** 单条翻译的 system 提示：只要译文，不要解释 */
function buildSystemPrompt(to: string, from?: string): string {
  const source = from ? `源语言为 ${from}。` : '源语言自动识别。';
  return (
    `你是翻译引擎。${source}把用户给出的文本翻译成目标语言 ${to}。` +
    '只输出译文本身，不要加引号、解释、语言标注或任何前后缀。' +
    '保持原文的段落结构与换行。'
  );
}

/** 批量翻译的 system 提示：要求返回与输入等长的 JSON 字符串数组 */
function buildBatchSystemPrompt(to: string, count: number, from?: string): string {
  const source = from ? `源语言为 ${from}。` : '源语言自动识别。';
  return (
    `你是翻译引擎。${source}把用户给出的 JSON 字符串数组中的每一项翻译成目标语言 ${to}。` +
    `数组共 ${count} 项，必须返回同样 ${count} 项的 JSON 字符串数组，顺序与输入严格一致。` +
    '只输出 JSON 数组本身，不要代码块标记、解释或任何其他文字。'
  );
}

/**
 * 解析批量响应为字符串数组。
 * 容忍模型偶尔包上 ```json 代码块，其余情况一律报格式错误。
 */
function parseBatchContent(content: string, expected: number): string[] {
  const trimmed = content.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFence);
  } catch (cause) {
    throw new TranslationError('unknown', '批量译文不是合法 JSON 数组', cause);
  }

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new TranslationError('unknown', '批量译文格式异常：应为字符串数组');
  }
  if (parsed.length !== expected) {
    throw new TranslationError(
      'unknown',
      `批量译文条数不符：期望 ${expected}，实际 ${parsed.length}`,
    );
  }
  return parsed as string[];
}

/** 批量结果包装为统一结果对象（长度已校验，逐项兜底防止索引越界） */
function toResults(texts: string[], translated: string[], from: string): TranslationResult[] {
  return texts.map((_, index) => ({
    text: translated[index] ?? '',
    from,
    engine: ENGINE,
  }));
}

/** 创建 OpenAI 兼容引擎实例（仅 background 中使用，key 不外流） */
export function createOpenAiProvider(config: OpenAiRequestConfig): Provider {
  return {
    engine: ENGINE,

    async translate(input: TranslateInput): Promise<TranslationResult> {
      const messages: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt(input.to, input.from) },
        { role: 'user', content: input.text },
      ];
      const content = await requestChatCompletion(config, messages);
      return { text: content.trim(), from: input.from ?? 'auto', engine: ENGINE };
    },

    async translateMany(input: TranslateManyInput): Promise<TranslationResult[]> {
      const { texts } = input;
      if (texts.length === 0) return [];

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: buildBatchSystemPrompt(input.to, texts.length, input.from),
        },
        { role: 'user', content: JSON.stringify(texts) },
      ];
      const content = await requestChatCompletion(config, messages);
      const translated = parseBatchContent(content, texts.length);
      return toResults(texts, translated, input.from ?? 'auto');
    },

    async testConnection(): Promise<void> {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are a translation engine. Reply with translation only.' },
        { role: 'user', content: PROBE_TEXT },
      ];
      await requestChatCompletion(config, messages);
    },
  };
}
