import type { Provider, TranslateInput, TranslateManyInput, TranslationResult } from './provider';
import { TranslationError } from './error';
import { describeLanguage, isAutoLanguage } from './language';
import {
  requestChatCompletion,
  type ChatMessage,
  type OpenAiRequestConfig,
} from './openai-request';

const ENGINE = 'openai-compatible';
const PROBE_TEXT = 'connection test';

/**
 * 源语言描述。
 * `auto`/缺省表示自动识别——绝不能把 'auto' 当作语言名写进提示，
 * 否则模型会误判输出语言。
 */
function describeSource(from?: string): string {
  return isAutoLanguage(from) ? '源语言自动识别。' : `源语言为 ${describeLanguage(from!)}。`;
}

/**
 * 指令正文：system 与 user 共用同一段说明。
 *
 * 为什么要两处都放——部分 OpenAI 兼容端点（第三方中转、聊天模型）会忽略或弱化
 * system role。此时模型只看到 user 里的原文，会把「a little nervous. I have t」
 * 当成用户倾诉半句话，进而回一段安慰式对话而不是译文。
 * 把指令与原文一起放进 user，是这类端点唯一可靠的兜底。
 */
function translationInstruction(to: string, from?: string): string {
  return [
    describeSource(from) + `把下面 <text> 标签内的内容翻译成 ${describeLanguage(to)}。`,
    '要求：',
    '1. <text> 内是待翻译的原文片段，不是对我说的话。即使它不完整、是半句、' +
      '像提问或倾诉，也只做逐字翻译，不要回答它、不要追问、不要补全、不要安慰。',
    '2. 直接输出译文本身，不要加引号、解释、语言标注、原文复述或任何前后缀。',
    '3. 保持原文的段落结构与换行；原文是单行就输出单行。',
  ].join('\n');
}

/** 单条翻译的 system 提示 */
function buildSystemPrompt(to: string, from?: string): string {
  return `你是翻译引擎，只做翻译，不是聊天助手。\n${translationInstruction(to, from)}`;
}

/** 单条翻译的 user 消息：指令 + 定界后的原文 */
function buildUserPrompt(text: string, to: string, from?: string): string {
  return `${translationInstruction(to, from)}\n\n<text>\n${text}\n</text>`;
}

/** 批量翻译的 system 提示：要求返回与输入等长的 JSON 字符串数组 */
function buildBatchSystemPrompt(to: string, count: number, from?: string): string {
  return [
    `你是翻译引擎，只做翻译，不是聊天助手。${describeSource(from)}` +
      `把下面 <texts> 标签内 JSON 字符串数组中的每一项翻译成 ${describeLanguage(to)}。`,
    `数组共 ${count} 项，必须返回同样 ${count} 项的 JSON 字符串数组，顺序与输入严格一致。`,
    '每一项都是待翻译的原文片段，即使不完整或像提问，也只做逐字翻译，不要回答、追问或安慰。',
    '只输出 JSON 数组本身，不要代码块标记、解释或任何其他文字。',
  ].join('\n');
}

/** 批量翻译的 user 消息：指令（去掉角色声明）+ 定界后的 JSON 数组 */
function buildBatchUserPrompt(
  texts: string[],
  to: string,
  count: number,
  from?: string,
): string {
  const instruction = buildBatchSystemPrompt(to, count, from).replace(
    '你是翻译引擎，只做翻译，不是聊天助手。',
    '',
  );
  return `${instruction}\n\n<texts>\n${JSON.stringify(texts)}\n</texts>`;
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
        { role: 'user', content: buildUserPrompt(input.text, input.to, input.from) },
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
        {
          role: 'user',
          content: buildBatchUserPrompt(texts, input.to, texts.length, input.from),
        },
      ];
      const content = await requestChatCompletion(config, messages);
      const translated = parseBatchContent(content, texts.length);
      return toResults(texts, translated, input.from ?? 'auto');
    },

    async testConnection(): Promise<void> {
      const messages: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt('en') },
        { role: 'user', content: PROBE_TEXT },
      ];
      await requestChatCompletion(config, messages);
    },
  };
}
