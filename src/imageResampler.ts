import { MAX_IMAGE_RECORD_IMAGE_PIXELS } from './measurementCsv'

export type ImageCrop = { x: number; y: number; width: number; height: number }
export type CropHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw' | 'move'

export function adjustImageCrop(crop: ImageCrop, handle: CropHandle, deltaX: number, deltaY: number, width: number, height: number): ImageCrop {
  const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, Math.round(value)))
  if (handle === 'move') return {
    ...crop,
    x: clamp(crop.x + deltaX, 0, width - crop.width),
    y: clamp(crop.y + deltaY, 0, height - crop.height),
  }
  const left = handle.includes('w') ? clamp(crop.x + deltaX, 0, crop.x + crop.width - 1) : crop.x
  const top = handle.includes('n') ? clamp(crop.y + deltaY, 0, crop.y + crop.height - 1) : crop.y
  const right = handle.includes('e') ? clamp(crop.x + crop.width + deltaX, crop.x + 1, width) : crop.x + crop.width
  const bottom = handle.includes('s') ? clamp(crop.y + crop.height + deltaY, crop.y + 1, height) : crop.y + crop.height
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function imageProcessingSize(width: number, height: number, crop: ImageCrop, reduction: number) {
  if (![width, height, crop.x, crop.y, crop.width, crop.height].every(Number.isInteger) ||
    width <= 0 || height <= 0 || width * height > MAX_IMAGE_RECORD_IMAGE_PIXELS ||
    crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 ||
    crop.x + crop.width > width || crop.y + crop.height > height ||
    !Number.isFinite(reduction) || reduction < 1 || reduction > 1.5) {
    throw new Error('Invalid crop or reduction factor (allowed: 1 to 1.5)')
  }
  return { width: Math.ceil(crop.width / reduction), height: Math.ceil(crop.height / reduction) }
}

export async function resampleMicroscopeImage(image: HTMLImageElement, crop: ImageCrop, reduction = 1): Promise<Blob> {
  const size = imageProcessingSize(image.naturalWidth, image.naturalHeight, crop, reduction)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas is unavailable')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  const scale = Math.max(size.width / crop.width, size.height / crop.height)
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width * scale, crop.height * scale)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png')
  })
}