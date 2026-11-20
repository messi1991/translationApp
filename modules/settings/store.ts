import { storage } from 'wxt/utils/storage';
import { DEFAULT_SETTINGS, resolveTargetLanguage, type Settings } from './schema';

const settingsItem = storage.defineItem<Partial<Settings>>('local:settings', {
  fallback: DEFAULT_SETTINGS,
});

/** 用默认值补齐缺失字段（旧版本存储可能缺新增字段或为空串），嵌套对象逐层合并 */
function withDefaults(stored: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    targetLanguage: resolveTargetLanguage(stored.targetLanguage),
    engines: {
      ...DEFAULT_SETTINGS.engines,
      ...stored.engines,
      'openai-compatible': {
        ...DEFAULT_SETTINGS.engines['openai-compatible'],
        ...stored.engines?.['openai-compatible'],
      },
    },
    features: { ...DEFAULT_SETTINGS.features, ...stored.features },
    blockedHosts: stored.blockedHosts ?? DEFAULT_SETTINGS.blockedHosts,
  };
}

/** 读取完整配置；无值时返回默认配置，残缺字段用默认值补齐 */
export const getSettings = async (): Promise<Settings> =>
  withDefaults(await settingsItem.getValue());

/** 全量写入配置（调用方基于 getSettings 的返回修改后写回） */
export const saveSettings = (next: Settings): Promise<void> =>
  settingsItem.setValue(next);

/** 监听配置变更（返回取消监听函数），回调参数始终经过默认值深合并补齐 */
export const watchSettings = (onChange: (next: Settings) => void): (() => void) =>
  settingsItem.watch((next) => {
    onChange(withDefaults(next ?? DEFAULT_SETTINGS));
  });
