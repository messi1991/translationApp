import type { EngineId } from '@/modules/settings';
import type { TranslationErrorCode } from './error';

export interface TranslateInput {
  /** 待翻译文本 */
  text: string;
  /** 目标语言 BCP-47 代码 */
  to: string;
  /** 源语言 BCP-47 代码；缺省时由引擎自动识别 */
  from?: string;
}

export interface TranslationResult {
  /** 译文 */
  text: string;
  /** 实际检测/命中的源语言 */
  from: string;
  /** 执行翻译的引擎 */
  engine: EngineId;
}

export interface Provider {
  readonly engine: EngineId;
  translate(input: TranslateInput): Promise<TranslationResult>;
  /**
   * 批量翻译（可选）：支持的引擎应把多段文本合并为一次请求，
   * 返回结果与 texts 顺序、长度一致。未实现的引擎不提供此方法，
   * 调用方需逐条 fallback 到 translate。
   */
  translateMany?(input: TranslateManyInput): Promise<TranslationResult[]>;
  testConnection(): Promise<void>;
}

export interface TranslateManyInput {
  /** 待翻译文本列表 */
  texts: string[];
  /** 目标语言 BCP-47 代码 */
  to: string;
  /** 源语言 BCP-47 代码；缺省时由引擎自动识别 */
  from?: string;
}

export interface TranslateErrorInfo {
  code: TranslationErrorCode;
  message: string;
}
