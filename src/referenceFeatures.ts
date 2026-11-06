import type { GeometryPoint, OrientedBox } from './boxGeometry'
import { loadOpenCv } from './objectDetection'

type OpenCv = typeof import('@techstark/opencv-js')
export type CvMat = InstanceType<OpenCv['Mat']>
export type SporePolarity = 'dark' | 'bright'

export type ReferenceFeatures = {
  width: number
  height: number
  q: number
  /** Solid spore area in source-image pixels². */
  area: number
  /** 256-bin grayscale histogram of the blurred box, normalised to sum to 1. */
  histogram: number[]
  /** Spore outline in source-image pixel coordinates. */
  outline: GeometryPoint[]
  polarity: SporePolarity
}

export type PatchFeatures = { histogram: number[]; area: number; outline: GeometryPoint[]; polarity: SporePolarity }

/** Samples an upright patch of `rect` (continuous pixel coordinates) from a single-channel image. */
export function extractPatch(cv: OpenCv, gray: CvMat, rect: OrientedBox): CvMat {
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  const radians = rect.angle * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const offsetX = 0.5 - width / 2
  const offsetY = 0.5 - height / 2
  const transform = cv.matFromArray(2, 3, cv.CV_64F, [
    cosine, -sine, rect.centerX - 0.5 + offsetX * cosine - offsetY * sine,
    sine, cosine, rect.centerY - 0.5 + offsetX * sine + offsetY * cosine,
  ])
  const patch = new cv.Mat()
  try {
    cv.warpAffine(gray, patch, transform, new cv.Size(width, height), cv.INTER_LINEAR + cv.WARP_INVERSE_MAP, cv.BORDER_REPLICATE)
  } finally {
    transform.delete()
  }
  return patch
}

export function analyzeReferencePatch(cv: OpenCv, gray: CvMat): PatchFeatures {
  const blurred = new cv.Mat()
  const binary = new cv.Mat()
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  try {
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_REPLICATE)

    const histogram = new Array<number>(256).fill(0)
    for (const value of blurred.data) histogram[value] += 1
    const total = blurred.rows * blurred.cols
    for (let bin = 0; bin < histogram.length; bin += 1) histogram[bin] /= total

    cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU)
    // The class that dominates the box border is background, so this works for dark and bright spores.
    let borderForeground = 0
    let borderTotal = 0
    for (let y = 0; y < binary.rows; y += 1) {
      for (let x = 0; x < binary.cols; x += 1) {
        if (y > 0 && y < binary.rows - 1 && x > 0 && x < binary.cols - 1) continue
        borderTotal += 1
        if (binary.data[y * binary.cols + x]) borderForeground += 1
      }
    }
    if (borderForeground * 2 > borderTotal) cv.bitwise_not(binary, binary)
    const polarity: SporePolarity = borderForeground * 2 > borderTotal ? 'dark' : 'bright'

    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    const center = new cv.Point(binary.cols / 2, binary.rows / 2)
    let bestIndex = -1
    let bestArea = -1
    let bestContainsCenter = false
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index)
      try {
        const containsCenter = cv.pointPolygonTest(contour, center, false) >= 0
        const area = cv.contourArea(contour)
        if ((containsCenter && !bestContainsCenter) || (containsCenter === bestContainsCenter && area > bestArea)) {
          bestIndex = index
          bestArea = area
          bestContainsCenter = containsCenter
        }
      } finally {
        contour.delete()
      }
    }
    if (bestIndex < 0) return { histogram, area: 0, outline: [], polarity }

    // Spores are always solid: the outer contour area ignores refraction holes, and matches how candidates are measured.
    const contour = contours.get(bestIndex)
    const outline: GeometryPoint[] = []
    for (let index = 0; index < contour.data32S.length; index += 2) outline.push({ x: contour.data32S[index], y: contour.data32S[index + 1] })
    contour.delete()
    return { histogram, area: bestArea, outline, polarity }
  } finally {
    blurred.delete()
    binary.delete()
    contours.delete()
    hierarchy.delete()
  }
}

export async function extractReferenceFeatures(image: HTMLImageElement, rect: OrientedBox): Promise<ReferenceFeatures> {
  const cv = await loadOpenCv()
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  const radians = rect.angle * Math.PI / 180
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas is unavailable')
  context.translate(width / 2, height / 2)
  context.rotate(-radians)
  context.translate(-rect.centerX, -rect.centerY)
  context.drawImage(image, 0, 0)

  const rgba = cv.imread(canvas)
  const gray = new cv.Mat()
  let patch: PatchFeatures
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY)
    patch = analyzeReferencePatch(cv, gray)
  } finally {
    rgba.delete()
    gray.delete()
  }
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  return {
    width: rect.width,
    height: rect.height,
    q: rect.width / rect.height,
    area: patch.area,
    histogram: patch.histogram,
    polarity: patch.polarity,
    outline: patch.outline.map((point) => {
      const offsetX = point.x + 0.5 - width / 2
      const offsetY = point.y + 0.5 - height / 2
      return { x: rect.centerX + offsetX * cosine - offsetY * sine, y: rect.centerY + offsetX * sine + offsetY * cosine }
    }),
  }
}
