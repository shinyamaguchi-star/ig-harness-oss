import { describe, expect, it } from 'vitest';
import { normalizeCommentTriggerKeywords } from '../engagement-gates.js';

describe('normalizeCommentTriggerKeywords', () => {
  it('trims blanks and removes case-insensitive duplicates', () => {
    expect(
      normalizeCommentTriggerKeywords([' 欲しい ', '', 'HOPE', 'hope', 'お願いします']),
    ).toEqual({ keywords: ['欲しい', 'HOPE', 'お願いします'], error: null });
  });

  it('converts the legacy single keyword when the array is omitted', () => {
    expect(normalizeCommentTriggerKeywords(undefined, ' 参加 ')).toEqual({
      keywords: ['参加'],
      error: null,
    });
  });

  it('accepts an empty array as all-comments mode', () => {
    expect(normalizeCommentTriggerKeywords([])).toEqual({ keywords: [], error: null });
  });

  it('rejects more than ten keyword slots', () => {
    const result = normalizeCommentTriggerKeywords(
      Array.from({ length: 11 }, (_, index) => `keyword-${index}`),
    );
    expect(result.error).toMatch(/up to 10/i);
  });

  it('rejects non-string entries', () => {
    expect(normalizeCommentTriggerKeywords(['ok', 123])).toEqual({
      keywords: [],
      error: 'trigger_keywords must contain only strings',
    });
  });
});
