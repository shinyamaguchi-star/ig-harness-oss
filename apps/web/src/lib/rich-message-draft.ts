import type { RichMessage, RichMessageBlock, RichMessageButton } from './api'

export interface EditableRichMessageDraft {
  text: string
  imageUrl: string
  buttonLabel: string
}

function firstCard(blocks: RichMessageBlock[]) {
  for (const block of blocks) {
    if (block.type === 'card') return block
    if (block.type === 'carousel' && block.cards[0]) return block.cards[0]
  }
  return null
}

function firstButtonLabel(buttons: RichMessageButton[] | undefined): string {
  return buttons?.[0]?.label ?? ''
}

/** Convert the standard IG Harness DM-template blocks back into the simple
 * campaign editor fields. This powers copy-on-write: a copied campaign keeps
 * sharing the original template until the operator chooses to change this
 * slot, at which point these values seed one new independent template. */
export function richMessageToEditableDraft(message: RichMessage): EditableRichMessageDraft {
  const card = firstCard(message.blocks)
  const standaloneText = message.blocks.find(
    (block): block is Extract<RichMessageBlock, { type: 'text' }> => block.type === 'text',
  )
  const quickReplies = message.blocks.find(
    (block): block is Extract<RichMessageBlock, { type: 'quick_replies' }> =>
      block.type === 'quick_replies',
  )
  const standaloneImage = message.blocks.find(
    (block): block is Extract<RichMessageBlock, { type: 'image' }> => block.type === 'image',
  )

  const cardText = card ? `${card.title}${card.subtitle ?? ''}` : ''
  const text = standaloneText?.text ?? quickReplies?.text ?? cardText
  const buttonLabel = card
    ? firstButtonLabel(card.buttons)
    : quickReplies?.replies[0]?.label ?? ''

  return {
    text,
    imageUrl: card?.image_url ?? standaloneImage?.url ?? '',
    buttonLabel,
  }
}
