import { describe, expect, it } from 'vitest'
import { richMessageToEditableDraft } from '../apps/web/src/lib/rich-message-draft'
import type { RichMessage } from '../apps/web/src/lib/api'

function message(blocks: RichMessage['blocks']): RichMessage {
  return {
    id: 'rm-1',
    name: 'template',
    kind: 'reward',
    blocks,
    created_at: '',
    updated_at: '',
  }
}

describe('richMessageToEditableDraft', () => {
  it('hydrates the standard card fields for copy-on-write editing', () => {
    expect(
      richMessageToEditableDraft(
        message([
          {
            type: 'card',
            title: '特典を',
            subtitle: '受け取ってください',
            image_url: 'https://example.com/reward.jpg',
            buttons: [{ type: 'url', label: '受け取る', url: '{REWARD_URL}' }],
          },
        ]),
      ),
    ).toEqual({
      text: '特典を受け取ってください',
      imageUrl: 'https://example.com/reward.jpg',
      buttonLabel: '受け取る',
    })
  })

  it('prefers the full standalone text used by long-message templates', () => {
    expect(
      richMessageToEditableDraft(
        message([
          { type: 'text', text: '省略されていない長い本文' },
          {
            type: 'card',
            title: '特典',
            buttons: [{ type: 'url', label: '開く', url: '{REWARD_URL}' }],
          },
        ]),
      ).text,
    ).toBe('省略されていない長い本文')
  })
})
