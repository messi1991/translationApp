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
  testConnection(): Promise<void>;
}

export interface TranslateErrorInfo {
  code: TranslationErrorCode;
  message: string;
}
