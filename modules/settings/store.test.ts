import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS } from './schema';
import { getSettings, saveSettings } from './store';

describe('settings store', () => {
  beforeEach(async () => {
    await browser.storage.local.clear();
  });

  it('空存储时返回默认配置', async () => {
    const s = await getSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(s.targetLanguage).toBe('zh-CN');
    expect(s.engine).toBe('edge');
    expect(s.features.selectionTranslate).toBe(true);
    expect(s.blockedHosts).toEqual([]);
  });

  it('saveSettings 持久化后重读一致', async () => {
    const current = await getSettings();
    await saveSettings({
      ...current,
      targetLanguage: 'ja',
      engine: 'openai-compatible',
      engines: {
        'openai-compatible': {
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-test',
          model: 'deepseek-chat',
        },
      },
    });

    const next = await getSettings();
    expect(next.targetLanguage).toBe('ja');
    expect(next.engine).toBe('openai-compatible');
    expect(next.engines['openai-compatible']).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
    });
  });

  it('功能开关可关闭', async () => {
    const current = await getSettings();
    await saveSettings({
      ...current,
      features: { selectionTranslate: false, youtubeSubtitles: true },
    });
    const next = await getSettings();
    expect(next.features.selectionTranslate).toBe(false);
    expect(next.features.youtubeSubtitles).toBe(true);
  });

  it('旧版本残缺配置用默认值补齐（不返回 undefined）', async () => {
    // 模拟旧版本写入的对象：只有目标语言与引擎
    await browser.storage.local.set({
      settings: { targetLanguage: 'ja', engine: 'edge' },
    });

    const s = await getSettings();
    expect(s.targetLanguage).toBe('ja');
    expect(s.engine).toBe('edge');
    expect(s.engines['openai-compatible']).toEqual(
      DEFAULT_SETTINGS.engines['openai-compatible'],
    );
    expect(s.features).toEqual(DEFAULT_SETTINGS.features);
    expect(s.blockedHosts).toEqual([]);
  });

  it('残缺的嵌套对象只补缺失字段，保留已有值', async () => {
    await browser.storage.local.set({
      settings: {
        targetLanguage: 'en',
        engine: 'openai-compatible',
        engines: { 'openai-compatible': { baseUrl: 'https://api.deepseek.com/v1' } },
        features: { selectionTranslate: false },
      },
    });

    const s = await getSettings();
    expect(s.engines['openai-compatible'].baseUrl).toBe('https://api.deepseek.com/v1');
    expect(s.engines['openai-compatible'].apiKey).toBe('');
    expect(s.engines['openai-compatible'].model).toBe('');
    expect(s.features.selectionTranslate).toBe(false);
    expect(s.features.youtubeSubtitles).toBe(true);
  });
});
