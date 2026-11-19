import { useState } from 'react';
import { requestClearCache } from '@/modules/translation-core';

type Status = { kind: 'idle' } | { kind: 'working' } | { kind: 'done' } | { kind: 'failed' };

/**
 * 清除翻译缓存：缓存体在 background（内存 + storage），
 * 故必须经消息通道交给 background 执行，options 页无法直接清。
 */
export default function ClearCache() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const run = async () => {
    setStatus({ kind: 'working' });
    const response = await requestClearCache();
    setStatus({ kind: response.ok ? 'done' : 'failed' });
  };

  const working = status.kind === 'working';

  return (
    <div className="clear-cache">
      <button type="button" onClick={() => void run()} disabled={working}>
        {working ? '清除中…' : '清除翻译缓存'}
      </button>
      {status.kind === 'done' && <span className="ok">缓存已清空</span>}
      {status.kind === 'failed' && <span className="failed">清除失败，请重试</span>}
      <p className="hint">
        已翻译过的文本会在本地缓存以加速显示；清除后下次翻译将重新请求模型。
        修改 API Key 或模型后清除一次可避免命中旧结果。
      </p>
    </div>
  );
}
