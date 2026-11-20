import { useState } from 'react';
import { formatTestConnectionError, requestTestConnection } from '@/modules/translation-core';

type Status =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'failed'; message: string };

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
    setStatus({
      kind: 'failed',
      message: formatTestConnectionError(response.code, response.message),
    });
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
