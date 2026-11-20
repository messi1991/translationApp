import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS } from './schema';
import { getSettings, saveSettings, watchSettings } from './store';

describe('settings store', () => {
  beforeEach(async () => {
    await browser.storage.local.clear();
  });

  it('空存储时返回默认配置（默认目标语言为简体中文 zh-CN，且候选含英语、日语等）', async () => {
    const s = await getSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(s.targetLanguage).toBe('zh-CN');
    expect(s.engine).toBe('edge');
    expect(s.features.selectionTranslate).toBe(true);
    expect(s.blockedHosts).toEqual([]);
  });

  it('旧存档中 targetLanguage 缺失或为空白时回退为简体中文 zh-CN', async () => {
    await browser.storage.local.set({
      settings: { targetLanguage: '   ', engine: 'edge' },
    });
    expect((await getSettings()).targetLanguage).toBe('zh-CN');

    await browser.storage.local.set({
      settings: { engine: 'edge' },
    });
    expect((await getSettings()).targetLanguage).toBe('zh-CN');
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

  it('watchSettings 在配置更新时推送补齐默认值后的完整 Settings，unwatch 后不再触发', async () => {
    const events: Array<{ yt: boolean; blocked: string[] }> = [];
    const unwatch = watchSettings((next) => {
      events.push({ yt: next.features.youtubeSubtitles, blocked: next.blockedHosts });
    });

    await saveSettings({
      ...DEFAULT_SETTINGS,
      features: { ...DEFAULT_SETTINGS.features, youtubeSubtitles: false },
      blockedHosts: ['youtube.com'],
    });

    expect(events).toEqual([{ yt: false, blocked: ['youtube.com'] }]);

    unwatch();
    await saveSettings(DEFAULT_SETTINGS);
    expect(events).toHaveLength(1);
  });
});
