import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, TARGET_LANGUAGES, type Settings } from '@/modules/settings';
import {
  changeEngine,
  changeTargetLanguage,
  derivePopupViewModel,
  extractSiteHost,
  toggleFeatureSwitch,
  toggleSiteEnabled,
} from './state';

describe('extractSiteHost（当前页面主机名提取）', () => {
  it('http/https 页面返回小写主机名，chrome:// / edge:// / 空值等特权页返回 null', () => {
    expect(extractSiteHost('https://WWW.YouTube.com/watch?v=123')).toBe('www.youtube.com');
    expect(extractSiteHost('http://docs.github.com/en')).toBe('docs.github.com');
    expect(extractSiteHost('chrome://extensions/')).toBeNull();
    expect(extractSiteHost('about:blank')).toBeNull();
    expect(extractSiteHost(undefined)).toBeNull();
    expect(extractSiteHost('not-a-valid-url')).toBeNull();
  });
});

describe('derivePopupViewModel（开关与引擎展示状态映射）', () => {
  it('默认配置 + 普通网页：全局开关开启、当前站点已启用、显示 Edge 免费端点与目标语言', () => {
    const vm = derivePopupViewModel(DEFAULT_SETTINGS, 'https://news.ycombinator.com/item?id=1');
    expect(vm).toEqual({
      selectionTranslate: true,
      youtubeSubtitles: true,
      siteHost: 'news.ycombinator.com',
      siteSupported: true,
      siteEnabled: true,
      matchedBlockRule: null,
      engineId: 'edge',
      engineLabel: 'Edge 免费端点',
      engineReady: true,
      engineOptions: [
        { id: 'edge', label: 'Edge 免费端点', ready: true },
        { id: 'openai-compatible', label: 'OpenAI 兼容（未配置密钥）', ready: false },
      ],
      targetLanguage: 'zh-CN',
      targetLanguageLabel: '简体中文',
    });
  });

  it('OpenAI 兼容引擎：已配置模型与 key 时显示模型名与就绪态，未填 key 时标记未就绪', () => {
    const unconfigured: Settings = {
      ...DEFAULT_SETTINGS,
      engine: 'openai-compatible',
    };
    const vmUnready = derivePopupViewModel(unconfigured, 'https://example.com');
    expect(vmUnready.engineLabel).toBe('OpenAI 兼容（未配置密钥）');
    expect(vmUnready.engineReady).toBe(false);

    const configured: Settings = {
      ...DEFAULT_SETTINGS,
      targetLanguage: 'ja',
      engine: 'openai-compatible',
      engines: {
        'openai-compatible': {
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-123',
          model: 'deepseek-chat',
        },
      },
    };
    const vmReady = derivePopupViewModel(configured, 'https://example.com');
    expect(vmReady.engineLabel).toBe('OpenAI 兼容 · deepseek-chat');
    expect(vmReady.engineReady).toBe(true);
    expect(vmReady.targetLanguageLabel).toBe('日语 (日本語)');
  });

  it('当前站点精确命中或父域命中黑名单时，siteEnabled 为 false 并给出命中的规则项', () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      blockedHosts: ['github.com'],
    };
    const vmSub = derivePopupViewModel(settings, 'https://gist.github.com/user/1');
    expect(vmSub.siteEnabled).toBe(false);
    expect(vmSub.matchedBlockRule).toBe('github.com');

    const vmPriv = derivePopupViewModel(settings, 'chrome://settings');
    expect(vmPriv.siteSupported).toBe(false);
    expect(vmPriv.siteHost).toBeNull();
    expect(vmPriv.siteEnabled).toBe(false);
  });
});

describe('changeEngine & changeTargetLanguage & toggleFeatureSwitch & toggleSiteEnabled（配置纯变换）', () => {
  it('支持在 edge 与 openai-compatible 之间切换全局引擎，非法值回退 edge', () => {
    expect(DEFAULT_SETTINGS.engine).toBe('edge');
    const toOpenAi = changeEngine(DEFAULT_SETTINGS, 'openai-compatible');
    expect(toOpenAi.engine).toBe('openai-compatible');

    const toEdge = changeEngine(toOpenAi, 'edge');
    expect(toEdge.engine).toBe('edge');

    const fallbackEdge = changeEngine(toOpenAi, 'unknown-engine');
    expect(fallbackEdge.engine).toBe('edge');
  });

  it('默认目标语言为简体中文（zh-CN），支持切换英语（en）、日语（ja）等，空值回退 zh-CN', () => {
    expect(DEFAULT_SETTINGS.targetLanguage).toBe('zh-CN');
    expect(TARGET_LANGUAGES.map((l) => l.code)).toEqual(
      expect.arrayContaining(['zh-CN', 'en', 'ja']),
    );

    const toEn = changeTargetLanguage(DEFAULT_SETTINGS, 'en');
    expect(toEn.targetLanguage).toBe('en');

    const toJa = changeTargetLanguage(toEn, 'ja');
    expect(toJa.targetLanguage).toBe('ja');

    const fallbackZh = changeTargetLanguage(toJa, '   ');
    expect(fallbackZh.targetLanguage).toBe('zh-CN');
  });

  it('切换划词或字幕开关仅更新对应布尔位，不改动其余配置', () => {
    const nextSel = toggleFeatureSwitch(DEFAULT_SETTINGS, 'selectionTranslate', false);
    expect(nextSel.features.selectionTranslate).toBe(false);
    expect(nextSel.features.youtubeSubtitles).toBe(true);

    const nextYt = toggleFeatureSwitch(nextSel, 'youtubeSubtitles', false);
    expect(nextYt.features.youtubeSubtitles).toBe(false);
  });

  it('在当前站点禁用时写入小写主机名（去重），重新启用时移除精确项与覆盖该子域的父域黑名单项', () => {
    const disabled = toggleSiteEnabled(DEFAULT_SETTINGS, 'WWW.Example.com', false);
    expect(disabled.blockedHosts).toEqual(['www.example.com']);

    // 重复禁用不产生重复项
    const disabledAgain = toggleSiteEnabled(disabled, 'www.example.com', false);
    expect(disabledAgain.blockedHosts).toEqual(['www.example.com']);

    // 在子域重新启用时，若父域 example.com 在黑名单中也一并移除使当前站点真正恢复启用
    const parentBlocked: Settings = {
      ...DEFAULT_SETTINGS,
      blockedHosts: ['Example.com', 'other.org'],
    };
    const reenabled = toggleSiteEnabled(parentBlocked, 'sub.example.com', true);
    expect(reenabled.blockedHosts).toEqual(['other.org']);
  });
});
