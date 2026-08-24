import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertReelCoverToJpeg } from '../apps/web/src/lib/reel-cover';

describe('convertReelCoverToJpeg', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('re-encodes PNG input as a width-limited JPEG with a .jpg filename', async () => {
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage, fillRect, fillStyle: '' })),
      toBlob: vi.fn((callback: (blob: Blob | null) => void, type?: string) => {
        callback(new Blob(['jpeg-bytes'], { type }));
      }),
    };

    class MockImage {
      naturalWidth = 2400;
      naturalHeight = 4266;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }

    vi.stubGlobal('Image', MockImage);
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-cover');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const input = new File(['png-bytes'], 'campaign.cover.png', {
      type: 'image/png',
      lastModified: 123,
    });
    const output = await convertReelCoverToJpeg(input);

    expect(output.type).toBe('image/jpeg');
    expect(output.name).toBe('campaign.cover.jpg');
    expect(output.lastModified).toBe(123);
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(3413);
    expect(fillRect).toHaveBeenCalledWith(0, 0, 1920, 3413);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.92);
    expect(revoke).toHaveBeenCalledWith('blob:test-cover');
  });

  it('rejects files that are not images before uploading', async () => {
    const input = new File(['text'], 'cover.txt', { type: 'text/plain' });
    await expect(convertReelCoverToJpeg(input)).rejects.toThrow(
      '表紙には画像ファイルを選択してください',
    );
  });
});
