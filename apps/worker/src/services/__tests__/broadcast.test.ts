import { describe, expect, it } from 'vitest';
import { describeBroadcastFailure } from '../broadcast.js';

describe('describeBroadcastFailure', () => {
  it('turns expired-token errors into an actionable Japanese message', () => {
    const result = describeBroadcastFailure(
      new Error('Instagram API error 401: {"error":{"message":"Invalid token","code":190}}'),
    );
    expect(result.code).toBe('190');
    expect(result.message).toContain('アクセストークン');
    expect(result.message).toContain('Meta code 190');
  });

  it('redacts tokens from unknown errors before persistence', () => {
    const result = describeBroadcastFailure(
      new Error('request failed access_token=secret-token-value&foo=bar'),
    );
    expect(result.code).toBeNull();
    expect(result.message).toContain('[REDACTED]');
    expect(result.message).not.toContain('secret-token-value');
  });

  it('explains permission error code 200', () => {
    const result = describeBroadcastFailure(
      new Error('API access blocked. code=200'),
    );
    expect(result.code).toBe('200');
    expect(result.message).toContain('公開状態');
  });
});
