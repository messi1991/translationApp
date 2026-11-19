import { useState } from 'react';
import { requestTestConnection } from '@/modules/translation-core';

type Status =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'failed'; message: string };

/** 错误码 → 面向用户的提示文案 */
const FAILURE_HINTS: Record<string, string> = {
  authentication: '鉴权失败，请检查 API Key 是否正确',
  'rate-limit': '请求过于频繁，请稍后重试',
  network: '网络不可达，请检查网络或 Base URL',
  'unsupported-language': '该引擎不支持当前语言对',
  unknown: '连接失败',
};

interface TestConnectionProps {
  /** 保存当前表单，使后台读到的是最新配置 */
  onBeforeTest: () => Promise<void>;
}

/** 引擎连通性测试：先落盘配置，再由 background 发一次探针请求 */
export default function TestConnection({ onBeforeTest }: TestConnectionProps) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const run = async () => {
    setStatus({ kind: 'testing' });
    await onBeforeTest();
    const response = await requestTestConnection({});
    if (response.ok) {
      setStatus({ kind: 'ok' });
      return;
    }
    setStatus({ kind: 'failed', message: FAILURE_HINTS[response.code] ?? response.message });
  };

  const testing = status.kind === 'testing';

  return (
    <div className="test-connection">
      <button type="button" onClick={() => void run()} disabled={testing}>
        {testing ? '测试中…' : '测试连接'}
      </button>
      {status.kind === 'ok' && <span className="ok">连接成功 ✓</span>}
      {status.kind === 'failed' && <span className="failed">{status.message}</span>}
    </div>
  );
}
