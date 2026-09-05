import { describe, expect, it } from 'vitest';
import { describeBroadcastFailure, isBroadcastBatchMinute, sendIgMessage } from '../broadcast.js';

describe('isBroadcastBatchMinute', () => {
  it.each([0, 2, 5, 7, 10, 12, 55, 57])('runs at minute %i', (minute) => {
    expect(isBroadcastBatchMinute(new Date(Date.UTC(2026, 8, 5, 9, minute)))).toBe(true);
  });

  it.each([1, 3, 4, 6, 8, 9, 58, 59])('waits at minute %i', (minute) => {
    expect(isBroadcastBatchMinute(new Date(Date.UTC(2026, 8, 5, 9, minute)))).toBe(false);
  });
});

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

describe('sendIgMessage', () => {
  it('sends text, image, and URL-button blocks as one rich broadcast', async () => {
    const client = {
      sendRichMessage: async (_recipient: string, blocks: unknown[]) => ({ sentBlocks: blocks.length }),
    };
    const blocks = [
      { type: 'text', text: 'お知らせです' },
      { type: 'image', url: 'https://example.com/image.jpg' },
      { type: 'card', title: '詳細', buttons: [{ type: 'url', label: '開く', url: 'https://example.com' }] },
    ];
    let captured: unknown[] | null = null;
    client.sendRichMessage = async (_recipient: string, sentBlocks: unknown[]) => {
      captured = sentBlocks;
      return { sentBlocks: sentBlocks.length };
    };

    await sendIgMessage(client as never, 'recipient-1', 'template', { blocks });

    expect(captured).toEqual(blocks);
  });
});
