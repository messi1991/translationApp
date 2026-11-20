import { describe, expect, it } from 'vitest';
import {
  chooseTrack,
  isAsrTrack,
  normalizeLangTag,
  originalAudioLang,
  type AudioFormat,
  type CaptionTrack,
} from './track';

describe('isAsrTrack', () => {
  it('kind === "asr" 识别为自动生成字幕', () => {
    expect(isAsrTrack({ languageCode: 'en', kind: 'asr', baseUrl: 'https://yt/1' })).toBe(true);
  });

  it('vssId 以 "a." 开头识别为自动生成字幕', () => {
    expect(isAsrTrack({ languageCode: 'en', vssId: 'a.en', baseUrl: 'https://yt/1' })).toBe(true);
  });

  it('手动字幕返回 false', () => {
    expect(isAsrTrack({ languageCode: 'en', vssId: '.en', baseUrl: 'https://yt/1' })).toBe(false);
  });
});

describe('normalizeLangTag', () => {
  it('统一中文繁简变体以便对齐', () => {
    expect(normalizeLangTag('zh-TW')).toBe(normalizeLangTag('zh-Hant'));
    expect(normalizeLangTag('zh-HK')).toBe(normalizeLangTag('zh-Hant-HK'));
    expect(normalizeLangTag('zh-CN')).toBe(normalizeLangTag('zh-Hans'));
    expect(normalizeLangTag('zh-CN')).not.toBe(normalizeLangTag('zh-TW'));
  });

  it('普通语言提取主语言子标签且忽略大小写与下划线', () => {
    expect(normalizeLangTag('en_US')).toBe('en');
    expect(normalizeLangTag('EN-gb')).toBe('en');
  });
});

describe('originalAudioLang', () => {
  const b64url = (raw: string): string =>
    btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  it('从含 original 标记的 xtags 解出原始音轨语言', () => {
    const formats: AudioFormat[] = [
      { audioTrack: { id: 'ar.10' }, xtags: b64url('acont=dubbed-auto:lang=ar') },
      { audioTrack: { id: 'en-US.4' }, xtags: b64url('acont=original:lang=en-US') },
      { audioTrack: { id: 'ja.10' }, xtags: b64url('acont=dubbed-auto:lang=ja') },
    ];
    expect(originalAudioLang(formats)).toBe('en-US');
  });

  it('支持 audioTrack.audioIsDefault 兜底', () => {
    const formats: AudioFormat[] = [
      { audioTrack: { id: 'es.10', audioIsDefault: false } },
      { audioTrack: { id: 'fr-FR.4', audioIsDefault: true } },
    ];
    expect(originalAudioLang(formats)).toBe('fr-FR');
  });

  it('无音轨元信息或非法 base64 时返回 undefined 不抛错', () => {
    expect(originalAudioLang([])).toBeUndefined();
    expect(
      originalAudioLang([{ audioTrack: { id: 'en.4' }, xtags: '%%%not-base64%%%' }]),
    ).toBeUndefined();
  });
});

describe('chooseTrack（手动 / ASR / 自动配音三类轨道选择）', () => {
  it('手动轨道：同源语言存在手动与 ASR 时优先选原语言手动字幕，避开译制手动字幕', () => {
    const tracks: CaptionTrack[] = [
      { languageCode: 'ja', vssId: '.ja', baseUrl: 'https://yt/ja-manual' },
      { languageCode: 'en-US', vssId: '.en-US', baseUrl: 'https://yt/en-manual' },
      { languageCode: 'en', kind: 'asr', vssId: 'a.en', baseUrl: 'https://yt/en-asr' },
    ];
    const picked = chooseTrack(tracks, { originalLang: 'en' });
    expect(picked?.baseUrl).toBe('https://yt/en-manual');
  });

  it('ASR 轨道：无原语言手动字幕时选原语言 ASR（即便存在其他语言手动译制轨）', () => {
    const tracks: CaptionTrack[] = [
      { languageCode: 'zh-Hans', vssId: '.zh-Hans', baseUrl: 'https://yt/zh-manual' },
      { languageCode: 'en', kind: 'asr', vssId: 'a.en', baseUrl: 'https://yt/en-asr' },
    ];
    const picked = chooseTrack(tracks, {});
    expect(picked?.baseUrl).toBe('https://yt/en-asr');
  });

  it('自动配音多 ASR 轨道：按 originalLang 选中原语言轨道而非顺位靠前的配音 ASR（如阿拉伯语）', () => {
    const tracks: CaptionTrack[] = [
      { languageCode: 'ar', kind: 'asr', vssId: 'a.ar', baseUrl: 'https://yt/ar-asr' },
      { languageCode: 'ja', kind: 'asr', vssId: 'a.ja', baseUrl: 'https://yt/ja-asr' },
      { languageCode: 'en', kind: 'asr', vssId: 'a.en', baseUrl: 'https://yt/en-asr' },
    ];
    const picked = chooseTrack(tracks, { originalLang: 'en-US' });
    expect(picked?.baseUrl).toBe('https://yt/en-asr');
  });

  it('多 ASR 且无 originalLang 时优先与手动字幕语言重合的语言', () => {
    const tracks: CaptionTrack[] = [
      { languageCode: 'ar', kind: 'asr', vssId: 'a.ar', baseUrl: 'https://yt/ar-asr' },
      { languageCode: 'en', kind: 'asr', vssId: 'a.en', baseUrl: 'https://yt/en-asr' },
      { languageCode: 'en-GB', vssId: '.en-GB', baseUrl: 'https://yt/en-manual' },
    ];
    const picked = chooseTrack(tracks);
    expect(picked?.baseUrl).toBe('https://yt/en-manual');
  });

  it('仅手动字幕时优先 defaultIndex 指定的默认轨道，否则回退首条手动轨道', () => {
    const tracks: CaptionTrack[] = [
      { languageCode: 'fr', vssId: '.fr', baseUrl: 'https://yt/fr' },
      { languageCode: 'de', vssId: '.de', baseUrl: 'https://yt/de' },
    ];
    expect(chooseTrack(tracks, { defaultIndex: 1 })?.baseUrl).toBe('https://yt/de');
    expect(chooseTrack(tracks)?.baseUrl).toBe('https://yt/fr');
  });

  it('zh-TW 与 zh-Hant 表记差异能正确匹配原语言手动字幕', () => {
    const tracks: CaptionTrack[] = [
      { languageCode: 'zh-Hant', vssId: '.zh-Hant', baseUrl: 'https://yt/hant' },
      { languageCode: 'zh-TW', kind: 'asr', vssId: 'a.zh-TW', baseUrl: 'https://yt/tw-asr' },
    ];
    expect(chooseTrack(tracks, { originalLang: 'zh-TW' })?.baseUrl).toBe('https://yt/hant');
  });

  it('空轨道列表返回 null', () => {
    expect(chooseTrack([])).toBeNull();
  });
});
