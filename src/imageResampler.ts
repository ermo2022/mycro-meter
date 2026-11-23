import { boxBounds } from './boxGeometry'
import { MAX_IMAGE_RECORD_IMAGE_PIXELS, type Measurement } from './measurementCsv'

export type ImageCrop = { x: number; y: number; width: number; height: number }
export type CropHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw' | 'move'

export function measurementCropBounds(measurements: readonly Measurement[]): ImageCrop | null {
  if (!measurements.length) return null
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const measurement of measurements) {
    const bounds = measurement.kind === 'box'
      ? boxBounds(measurement.rect)
      : { x: Math.min(measurement.start.x, measurement.end.x), y: Math.min(measurement.start.y, measurement.end.y), width: Math.abs(measurement.end.x - measurement.start.x), height: Math.abs(measurement.end.y - measurement.start.y) }
    left = Math.min(left, bounds.x)
    top = Math.min(top, bounds.y)
    right = Math.max(right, bounds.x + bounds.width)
    bottom = Math.max(bottom, bounds.y + bounds.height)
  }
  const x = Math.floor(left + 1e-7)
  const y = Math.floor(top + 1e-7)
  return { x, y, width: Math.ceil(right - 1e-7) - x, height: Math.ceil(bottom - 1e-7) - y }
}

export function cropContainsBounds(crop: ImageCrop, bounds: ImageCrop | null): boolean {
  return !bounds || (crop.x <= bounds.x && crop.y <= bounds.y &&
    crop.x + crop.width >= bounds.x + bounds.width && crop.y + crop.height >= bounds.y + bounds.height)
}

export function constrainCropToBounds(crop: ImageCrop, bounds: ImageCrop | null, width: number, height: number, move = false): ImageCrop {
  if (!bounds) return crop
  const left = Math.max(0, bounds.x)
  const top = Math.max(0, bounds.y)
  const right = Math.min(width, bounds.x + bounds.width)
  const bottom = Math.min(height, bounds.y + bounds.height)
  if (move && crop.width >= right - left && crop.height >= bottom - top) {
    return {
      ...crop,
      x: Math.max(0, right - crop.width, Math.min(crop.x, left, width - crop.width)),
      y: Math.max(0, bottom - crop.height, Math.min(crop.y, top, height - crop.height)),
    }
  }
  const x = Math.min(crop.x, left)
  const y = Math.min(crop.y, top)
  return { x, y, width: Math.max(crop.x + crop.width, right) - x, height: Math.max(crop.y + crop.height, bottom) - y }
}

export function translateCroppedMeasurements(measurements: readonly Measurement[], crop: ImageCrop): Measurement[] {
  return measurements.map((measurement) => measurement.kind === 'box'
    ? { ...measurement, rect: { ...measurement.rect, centerX: measurement.rect.centerX - crop.x, centerY: measurement.rect.centerY - crop.y } }
    : { ...measurement, start: { x: measurement.start.x - crop.x, y: measurement.start.y - crop.y }, end: { x: measurement.end.x - crop.x, y: measurement.end.y - crop.y } })
}

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