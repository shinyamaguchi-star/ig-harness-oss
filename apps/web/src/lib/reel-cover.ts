const JPEG_MIME_TYPE = 'image/jpeg'
const REEL_COVER_WIDTH = 420
const REEL_COVER_HEIGHT = 654
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
const JPEG_QUALITIES = [0.92, 0.85, 0.75, 0.65]

function loadLocalImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    const release = () => URL.revokeObjectURL(objectUrl)

    image.onload = () => {
      release()
      resolve(image)
    }
    image.onerror = () => {
      release()
      reject(new Error('表紙画像を読み込めませんでした'))
    }
    image.src = objectUrl
  })
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob || blob.type !== JPEG_MIME_TYPE) {
        reject(new Error('表紙画像をJPEGへ変換できませんでした'))
        return
      }
      resolve(blob)
    }, JPEG_MIME_TYPE, quality)
  })
}

function jpegFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '') || 'reel-cover'
  return `${base}.jpg`
}

/**
 * Meta accepts Reel cover photos as JPEG only. Re-encode every selected
 * image in the browser so PNG input and JPEGs with a non-sRGB colour profile
 * both become a predictable 420x654 JPEG before they reach R2 or Graph API.
 */
export async function convertReelCoverToJpeg(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) {
    throw new Error('表紙には画像ファイルを選択してください')
  }

  const image = await loadLocalImage(file)
  if (!image.naturalWidth || !image.naturalHeight) {
    throw new Error('表紙画像のサイズを確認できませんでした')
  }

  const canvas = document.createElement('canvas')
  canvas.width = REEL_COVER_WIDTH
  canvas.height = REEL_COVER_HEIGHT

  const context = canvas.getContext('2d', { colorSpace: 'srgb' })
  if (!context) throw new Error('表紙画像を変換する機能を利用できません')

  // JPEG has no transparency. Use white rather than allowing transparent PNG
  // pixels to become an implementation-dependent dark background.
  context.fillStyle = '#FFFFFF'
  context.fillRect(0, 0, REEL_COVER_WIDTH, REEL_COVER_HEIGHT)

  // Instagram's Reel cover canvas is 420x654 (about 1:1.55), not the
  // video's 9:16 canvas. Centre-crop rather than stretch so text and people
  // keep their proportions and the uploaded cover conforms exactly.
  const targetRatio = REEL_COVER_WIDTH / REEL_COVER_HEIGHT
  const sourceRatio = image.naturalWidth / image.naturalHeight
  let sourceX = 0
  let sourceY = 0
  let sourceWidth = image.naturalWidth
  let sourceHeight = image.naturalHeight
  if (sourceRatio > targetRatio) {
    sourceWidth = image.naturalHeight * targetRatio
    sourceX = (image.naturalWidth - sourceWidth) / 2
  } else if (sourceRatio < targetRatio) {
    sourceHeight = image.naturalWidth / targetRatio
    sourceY = (image.naturalHeight - sourceHeight) / 2
  }
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    REEL_COVER_WIDTH,
    REEL_COVER_HEIGHT,
  )

  let jpeg: Blob | null = null
  for (const quality of JPEG_QUALITIES) {
    jpeg = await canvasToJpeg(canvas, quality)
    if (jpeg.size <= MAX_UPLOAD_BYTES) break
  }
  if (!jpeg || jpeg.size > MAX_UPLOAD_BYTES) {
    throw new Error('JPEG変換後の表紙画像が5MBを超えています。より小さい画像を選択してください')
  }

  return new File([jpeg], jpegFilename(file.name), {
    type: JPEG_MIME_TYPE,
    lastModified: file.lastModified,
  })
}
