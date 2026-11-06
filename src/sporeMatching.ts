import { longAxisFirst, normalizeBoxAngle, type OrientedBox } from './boxGeometry'
import { loadOpenCv } from './objectDetection'
import { analyzeReferencePatch, extractPatch, type CvMat, type ReferenceFeatures } from './referenceFeatures'

type OpenCv = typeof import('@techstark/opencv-js')
type RotatedRect = ReturnType<OpenCv['minAreaRect']>

export type SporeMatch = OrientedBox & { id: string; area: number; q: number; distance: number; source: 'direct' | 'watershed' }
export type SporeMatchResult = { matches: SporeMatch[]; candidates: number; directCandidates: number; clusterCandidates: number }
export type MatchLimits = { minArea: number; maxArea: number; maxDistance: number; qTolerance: number }

export const DIRECT_LIMITS: MatchLimits = { minArea: 0.7, maxArea: 1.3, maxDistance: 0.3, qTolerance: 0.2 }
// Watershed segments are held to tighter limits to avoid wishful matches.
export const WATERSHED_LIMITS: MatchLimits = { minArea: 0.8, maxArea: 1.2, maxDistance: 0.25, qTolerance: 0.15 }
const NOISE_AREA_RATIO = 0.6
const OVERSIZE_AREA_RATIO = 4
const MAX_PROCESSING_SIDE = 3000

/** Equivalent to cv.compareHist(HISTCMP_BHATTACHARYYA) for histograms that each sum to 1. */
export function bhattacharyyaDistance(first: number[], second: number[]) {
  let coefficient = 0
  for (let bin = 0; bin < first.length; bin += 1) coefficient += Math.sqrt(first[bin] * second[bin])
  return Math.sqrt(Math.max(0, 1 - coefficient))
}

export function areaGroup(area: number, referenceArea: number, limits: MatchLimits = DIRECT_LIMITS): 'reject' | 'direct' | 'cluster' {
  const ratio = area / referenceArea
  if (ratio < NOISE_AREA_RATIO || ratio > OVERSIZE_AREA_RATIO) return 'reject'
  if (ratio > limits.maxArea) return 'cluster'
  return ratio >= limits.minArea ? 'direct' : 'reject'
}

export function isSporeMatch(q: number, distance: number, reference: Pick<ReferenceFeatures, 'q'>, limits: MatchLimits) {
  return distance < limits.maxDistance && Math.abs(q - reference.q) <= reference.q * limits.qTolerance
}

function rotatedRectBox(cv: OpenCv, rect: RotatedRect): OrientedBox {
  const [first, second, third] = cv.boxPoints(rect)
  const firstLength = Math.hypot(second.x - first.x, second.y - first.y)
  const secondLength = Math.hypot(third.x - second.x, third.y - second.y)
  const [start, end] = firstLength >= secondLength ? [first, second] : [second, third]
  return longAxisFirst({
    // OpenCV pixel centres are integers; app coordinates put them at +0.5.
    centerX: rect.center.x + 0.5,
    centerY: rect.center.y + 0.5,
    width: Math.max(firstLength, secondLength),
    height: Math.min(firstLength, secondLength),
    angle: normalizeBoxAngle(Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI),
  })
}

export function watershedSegments(cv: OpenCv, blurred: CvMat, contour: CvMat): CvMat[] {
  const bounds = cv.boundingRect(contour)
  const region = new cv.Rect(bounds.x, bounds.y, bounds.width, bounds.height)
  const single = new cv.MatVector()
  const emptyHierarchy = new cv.Mat()
  const mask = new cv.Mat(bounds.height, bounds.width, cv.CV_8UC1, new cv.Scalar(0))
  const distance = new cv.Mat()
  const sureForeground = new cv.Mat()
  const sureForeground8 = new cv.Mat()
  const markers = new cv.Mat()
  const view = blurred.roi(region)
  const color = new cv.Mat()
  const segments: CvMat[] = []
  try {
    single.push_back(contour)
    cv.drawContours(mask, single, 0, new cv.Scalar(255), cv.FILLED, cv.LINE_8, emptyHierarchy, 0, new cv.Point(-bounds.x, -bounds.y))
    cv.distanceTransform(mask, distance, cv.DIST_L2, 5)
    let peak = 0
    for (const value of distance.data32F) peak = Math.max(peak, value)
    cv.threshold(distance, sureForeground, peak * 0.5, 255, cv.THRESH_BINARY)
    sureForeground.convertTo(sureForeground8, cv.CV_8U)
    const labelCount = cv.connectedComponents(sureForeground8, markers, 8, cv.CV_32S)
    if (labelCount <= 2) return segments

    // Background outside the blob is 1, seeds are 2.., and the uncertain band is 0 for watershed to fill.
    const labels = markers.data32S
    for (let index = 0; index < labels.length; index += 1) {
      labels[index] = mask.data[index] ? (sureForeground8.data[index] ? labels[index] + 1 : 0) : 1
    }
    cv.cvtColor(view, color, cv.COLOR_GRAY2RGB)
    cv.watershed(color, markers)

    for (let label = 2; label <= labelCount; label += 1) {
      const segment = new cv.Mat(bounds.height, bounds.width, cv.CV_8UC1, new cv.Scalar(0))
      const segmentContours = new cv.MatVector()
      const segmentHierarchy = new cv.Mat()
      try {
        for (let index = 0; index < labels.length; index += 1) if (labels[index] === label) segment.data[index] = 255
        cv.findContours(segment, segmentContours, segmentHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE, new cv.Point(bounds.x, bounds.y))
        let largest: CvMat | null = null
        let largestArea = 0
        for (let index = 0; index < segmentContours.size(); index += 1) {
          const candidate = segmentContours.get(index)
          const area = cv.contourArea(candidate)
          if (area > largestArea) {
            largest?.delete()
            largest = candidate
            largestArea = area
          } else {
            candidate.delete()
          }
        }
        if (largest) segments.push(largest)
      } finally {
        segment.delete()
        segmentContours.delete()
        segmentHierarchy.delete()
      }
    }
    return segments
  } finally {
    single.delete()
    emptyHierarchy.delete()
    mask.delete()
    distance.delete()
    sureForeground.delete()
    sureForeground8.delete()
    markers.delete()
    view.delete()
    color.delete()
  }
}

export async function findMatchingSpores(image: HTMLImageElement, reference: ReferenceFeatures): Promise<SporeMatchResult> {
  const cv = await loadOpenCv()
  const scale = Math.min(1, MAX_PROCESSING_SIDE / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas is unavailable')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)

  const referenceArea = reference.area * scale * scale
  const blockSize = Math.max(11, 2 * Math.round(reference.width * scale) + 1)
  const source = cv.imread(canvas)
  const gray = new cv.Mat()
  const blurred = new cv.Mat()
  const otsuBinary = new cv.Mat()
  const edges = new cv.Mat()
  const adaptive = new cv.Mat()
  const combined = new cv.Mat()
  const filled = new cv.Mat(canvas.height, canvas.width, cv.CV_8UC1, new cv.Scalar(0))
  const outlineContours = new cv.MatVector()
  const blobContours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3))
  const matches: SporeMatch[] = []
  let candidates = 0
  let directCandidates = 0
  let clusterCandidates = 0

  const evaluate = (contour: CvMat, limits: MatchLimits, kind: SporeMatch['source']) => {
    const box = rotatedRectBox(cv, cv.minAreaRect(contour))
    if (box.height <= 0) return
    const patch = extractPatch(cv, gray, box)
    let distance: number
    try {
      distance = bhattacharyyaDistance(analyzeReferencePatch(cv, patch).histogram, reference.histogram)
    } finally {
      patch.delete()
    }
    const q = box.width / box.height
    if (!isSporeMatch(q, distance, reference, limits)) return
    matches.push({
      centerX: box.centerX / scale,
      centerY: box.centerY / scale,
      width: box.width / scale,
      height: box.height / scale,
      angle: box.angle,
      area: cv.contourArea(contour) / (scale * scale),
      q,
      distance,
      source: kind,
      id: `match-${matches.length + 1}`,
    })
  }

  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY)
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_REPLICATE)
    const otsu = cv.threshold(blurred, otsuBinary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU)
    cv.Canny(blurred, edges, otsu * 0.5, otsu)
    cv.adaptiveThreshold(blurred, adaptive, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, reference.polarity === 'dark' ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY, blockSize, 5)
    cv.bitwise_or(edges, adaptive, combined)
    cv.morphologyEx(combined, combined, cv.MORPH_CLOSE, kernel)
    cv.findContours(combined, outlineContours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    // Spores are solid, so fill outlines before measuring area.
    cv.drawContours(filled, outlineContours, -1, new cv.Scalar(255), cv.FILLED)
    cv.findContours(filled, blobContours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    for (let index = 0; index < blobContours.size(); index += 1) {
      const contour = blobContours.get(index)
      try {
        const bounds = cv.boundingRect(contour)
        if (bounds.x <= 0 || bounds.y <= 0 || bounds.x + bounds.width >= canvas.width || bounds.y + bounds.height >= canvas.height) continue
        const group = areaGroup(cv.contourArea(contour), referenceArea)
        if (group === 'reject') continue
        candidates += 1
        if (group === 'direct') {
          directCandidates += 1
          evaluate(contour, DIRECT_LIMITS, 'direct')
          continue
        }
        clusterCandidates += 1
        for (const segment of watershedSegments(cv, blurred, contour)) {
          try {
            if (areaGroup(cv.contourArea(segment), referenceArea, WATERSHED_LIMITS) === 'direct') evaluate(segment, WATERSHED_LIMITS, 'watershed')
          } finally {
            segment.delete()
          }
        }
      } finally {
        contour.delete()
      }
    }
  } finally {
    source.delete()
    gray.delete()
    blurred.delete()
    otsuBinary.delete()
    edges.delete()
    adaptive.delete()
    combined.delete()
    filled.delete()
    outlineContours.delete()
    blobContours.delete()
    hierarchy.delete()
    kernel.delete()
  }
  return { matches, candidates, directCandidates, clusterCandidates }
}
