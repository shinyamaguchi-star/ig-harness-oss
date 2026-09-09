import { describe, expect, it } from 'vitest';
import { classifyUnhandledWorkerError } from '../index.js';

describe('classifyUnhandledWorkerError', () => {
  it('explains the D1 daily read limit and uses a retryable HTTP status', () => {
    const result = classifyUnhandledWorkerError(
      new Error(
        "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade or wait until midnight UTC.",
      ),
    );

    expect(result.status).toBe(503);
    expect(result.message).toContain('読取上限');
    expect(result.message).toContain('日本時間9:00');
    expect(result.message).toContain('保存されていません');
  });

  it('checks nested causes because D1 may put the detailed error there', () => {
    const outer = new Error('D1 request failed', {
      cause: new Error('Cannot resolve D1 DB due to transient issue on remote node.'),
    });

    const result = classifyUnhandledWorkerError(outer);
    expect(result.status).toBe(503);
    expect(result.message).toContain('一時的な接続エラー');
  });

  it('does not expose an unknown internal exception', () => {
    const result = classifyUnhandledWorkerError(new Error('secret database detail'));

    expect(result.status).toBe(500);
    expect(result.message).not.toContain('secret database detail');
    expect(result.message).toContain('発生時刻');
  });
});
