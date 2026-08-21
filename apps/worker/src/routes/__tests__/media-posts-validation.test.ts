/**
 * Tests: validateMediaPostInput — post_type × media integrity rules.
 * Also: normalizeScheduledAt — JST interpretation of offset-less input
 * (final review Fix 2).
 */
import { describe, it, expect } from 'vitest';
import {
  validateMediaPostInput,
  validateReelCoverInput,
  normalizeScheduledAt,
} from '../media-posts.js';

const img = { url: 'https://example.com/a.jpg', type: 'image' as const };
const vid = { url: 'https://example.com/v.mp4', type: 'video' as const };

describe('validateMediaPostInput', () => {
  it('accepts a single-image feed post', () => {
    expect(validateMediaPostInput('feed_image', [img])).toBeNull();
  });
  it('rejects feed_image with a video', () => {
    expect(validateMediaPostInput('feed_image', [vid])).toMatch(/image/);
  });
  it('rejects feed_image with 2 items', () => {
    expect(validateMediaPostInput('feed_image', [img, img])).toMatch(/1/);
  });
  it('accepts a reel with a single video', () => {
    expect(validateMediaPostInput('reel', [vid])).toBeNull();
  });
  it('rejects a reel with an image', () => {
    expect(validateMediaPostInput('reel', [img])).toMatch(/video/);
  });
  it('accepts a story with one or multiple image/video frames', () => {
    expect(validateMediaPostInput('story', [img])).toBeNull();
    expect(validateMediaPostInput('story', [vid])).toBeNull();
    expect(validateMediaPostInput('story', [img, vid, img])).toBeNull();
  });
  it('rejects a story with more than 20 frames', () => {
    expect(validateMediaPostInput('story', Array(21).fill(img))).toMatch(/20/);
  });
  it('accepts a carousel with 2-10 items', () => {
    expect(validateMediaPostInput('carousel', [img, vid])).toBeNull();
  });
  it('rejects a carousel with 1 item', () => {
    expect(validateMediaPostInput('carousel', [img])).toMatch(/2/);
  });
  it('rejects a carousel with 11 items', () => {
    expect(validateMediaPostInput('carousel', Array(11).fill(img))).toMatch(/10/);
  });
  it('rejects an unknown post_type', () => {
    expect(validateMediaPostInput('album' as never, [img])).toMatch(/post_type/);
  });
  it('rejects non-http URLs', () => {
    expect(
      validateMediaPostInput('feed_image', [{ url: 'ftp://x/a.jpg', type: 'image' }]),
    ).toMatch(/URL/i);
  });
  it('rejects empty media', () => {
    expect(validateMediaPostInput('story', [])).toMatch(/media/);
  });
});

describe('validateReelCoverInput', () => {
  it('accepts a public cover URL for a reel', () => {
    expect(
      validateReelCoverInput('reel', 'https://cdn.example.com/cover.jpg', undefined),
    ).toBeNull();
  });

  it('accepts a non-negative thumbnail offset for a reel', () => {
    expect(validateReelCoverInput('reel', undefined, 2500)).toBeNull();
  });

  it('rejects cover settings for non-reel posts', () => {
    expect(
      validateReelCoverInput('feed_image', 'https://cdn.example.com/cover.jpg', undefined),
    ).toMatch(/reel/i);
  });

  it('rejects a non-public cover URL', () => {
    expect(validateReelCoverInput('reel', 'http://localhost/cover.jpg', undefined)).toMatch(
      /https/i,
    );
  });

  it('rejects negative or fractional millisecond offsets', () => {
    expect(validateReelCoverInput('reel', undefined, -1)).toMatch(/non-negative/i);
    expect(validateReelCoverInput('reel', undefined, 1.5)).toMatch(/integer/i);
  });
});

describe('normalizeScheduledAt', () => {
  it('interprets an offset-less string as JST', () => {
    const result = normalizeScheduledAt('2026-07-24T09:00:00');
    expect(result).not.toBeNull();
    expect(result).toContain('09:00:00.000+09:00');
  });

  it('converts a Z string to the equivalent JST wall time', () => {
    const result = normalizeScheduledAt('2026-07-24T00:00:00Z');
    expect(result).not.toBeNull();
    expect(result).toContain('09:00:00.000+09:00');
  });

  it('passes an explicit +09:00 string through as the same instant', () => {
    const result = normalizeScheduledAt('2026-07-24T09:00:00+09:00');
    expect(result).not.toBeNull();
    expect(result).toContain('09:00:00.000+09:00');
  });

  it('returns null for unparseable input', () => {
    expect(normalizeScheduledAt('not-a-date')).toBeNull();
  });
});
