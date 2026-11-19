import { boxCorners, longAxisFirst, normalizeBoxAngle, type GeometryPoint, type OrientedBox } from './boxGeometry'
import { loadOpenCv } from './objectDetection'
import { analyzeReferencePatch, extractPatch, type CvMat, type ReferenceFeatures } from './referenceFeatures'

type OpenCv = typeof import('@techstark/opencv-js')
type RotatedRect = ReturnType<OpenCv['minAreaRect']>

export type SporeMatch = OrientedBox & { id: string; area: number; q: number; distance: number; source: 'direct' | 'watershed'; outline: GeometryPoint[]; recovery?: 'contrast' | 'rim' }
export type SporeMatchResult = { matches: SporeMatch[]; candidates: number; directCandidates: number; clusterCandidates: number; rejectedOutlines: GeometryPoint[][] }
export type MatchingSettings = { smoothing: number; sensitivity: number; sizeTolerance: number; relativeContrast?: boolean; recoverIncompleteRims?: boolean }
export const DEFAULT_MATCHING_SETTINGS: MatchingSettings = { smoothing: 2, sensitivity: 5, sizeTolerance: 45, relativeContrast: true, recoverIncompleteRims: true }
export type MatchLimits = { minArea: number; maxArea: number; maxDistance: number; qTolerance: number }
export type MatchTrace = {
  stage: 'generated' | 'framePassed' | 'areaPassed' | 'geometry' | 'segmentAreaPassed' | 'evaluated' | 'rejected'
  source: SporeMatch['source']
  box: OrientedBox
  areaRatio: number
  reason?: string
  distance?: number
  relativeDistance?: number
  histogramPassed?: boolean
  qPassed?: boolean
}
export type MatchObserver = (event: MatchTrace, contour: CvMat) => void
export type CandidatePreprocessing = {
  mask?: 'combined' | 'edges' | 'adaptive'
  correctIllumination?: boolean
  tuning?: MatchingSettings
}
export const DEFAULT_CANDIDATE_PREPROCESSING: CandidatePreprocessing = { mask: 'adaptive', correctIllumination: true }

export const DIRECT_LIMITS: MatchLimits = { minArea: 0.7, maxArea: 1.3, maxDistance: 0.3, qTolerance: 0.2 }
// Watershed segments are held to tighter limits to avoid wishful matches.
export const WATERSHED_LIMITS: MatchLimits = { minArea: 0.8, maxArea: 1.2, maxDistance: 0.25, qTolerance: 0.15 }
const NOISE_AREA_RATIO = 0.6
const OVERSIZE_AREA_RATIO = 4
export const MAX_PROCESSING_SIDE = 3000

/** Equivalent to cv.compareHist(HISTCMP_BHATTACHARYYA) for histograms that each sum to 1. */
export function bhattacharyyaDistance(first: number[], second: number[]) {
  let coefficient = 0
  for (let bin = 0; bin < first.length; bin += 1) coefficient += Math.sqrt(first[bin] * second[bin])
  return Math.sqrt(Math.max(0, 1 - coefficient))
}

export function normalizeContrastHistogram(histogram: number[]) {
  const quantile = (probability: number) => {
    let sum = 0
    for (let bin = 0; bin < histogram.length; bin += 1) {
      sum += histogram[bin]
      if (sum >= probability) return bin
    }
    return histogram.length - 1
  }
  const low = quantile(0.05)
  const span = quantile(0.95) - low
  const normalized = new Array<number>(32).fill(0)
  for (let bin = 0; bin < histogram.length; bin += 1) {
    normalized[Math.max(0, Math.min(31, Math.round((bin - low) * 31 / Math.max(1, span))))] += histogram[bin]
  }
  return { histogram: normalized, span }
}

export function rimBoundarySupport(cv: OpenCv, contour: CvMat, hull: CvMat, tolerance: number) {
  const points = hull.data32S
  let perimeter = 0
  let supported = 0
  for (let index = 0; index < points.length; index += 2) {
    const next = (index + 2) % points.length
    const length = Math.hypot(points[next] - points[index], points[next + 1] - points[index + 1])
    const samples = Math.max(1, Math.ceil(length / 2))
    for (let sample = 0; sample < samples; sample += 1) {
      const fraction = (sample + 0.5) / samples
      const point = new cv.Point(points[index] + (points[next] - points[index]) * fraction, points[index + 1] + (points[next + 1] - points[index + 1]) * fraction)
      perimeter += length / samples
      if (Math.abs(cv.pointPolygonTest(contour, point, true)) <= tolerance) supported += length / samples
    }
  }
  return supported / Math.max(1, perimeter)
}

export function boxIntersectionOverUnion(cv: OpenCv, first: OrientedBox, second: OrientedBox) {
  if (Math.hypot(first.centerX - second.centerX, first.centerY - second.centerY) > (Math.hypot(first.width, first.height) + Math.hypot(second.width, second.height)) / 2) return 0
  const polygon = (box: OrientedBox) => cv.matFromArray(4, 1, cv.CV_32FC2, boxCorners(box).flatMap((point) => [point.x, point.y]))
  const firstPolygon = polygon(first)
  const secondPolygon = polygon(second)
  const intersection = new cv.Mat()
  try {
    const area = Math.max(0, cv.intersectConvexConvex(firstPolygon, secondPolygon, intersection, true))
    return area / Math.max(1, first.width * first.height + second.width * second.height - area)
  } finally {
    firstPolygon.delete()
    secondPolygon.delete()
    intersection.delete()
  }
}

export function areaGroup(area: number, referenceArea: number, limits: MatchLimits = DIRECT_LIMITS): 'reject' | 'direct' | 'cluster' {
  const ratio = area / referenceArea
  if (ratio < Math.min(NOISE_AREA_RATIO, limits.minArea) || ratio > OVERSIZE_AREA_RATIO) return 'reject'
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

export function overlapsReference(box: OrientedBox, referenceBox: OrientedBox, scale: number) {
  const candidate = boxCorners({
    ...box,
    centerX: box.centerX / scale,
    centerY: box.centerY / scale,
    width: box.width / scale,
    height: box.height / scale,
  })
  const reference = boxCorners(referenceBox)
  for (const corners of [candidate, reference]) {
    for (let index = 0; index < 2; index += 1) {
      const start = corners[index]
      const end = corners[index + 1]
      const axisX = -(end.y - start.y)
      const axisY = end.x - start.x
      const candidateProjection = candidate.map((point) => point.x * axisX + point.y * axisY)
      const referenceProjection = reference.map((point) => point.x * axisX + point.y * axisY)
      if (Math.max(...candidateProjection) < Math.min(...referenceProjection)
        || Math.max(...referenceProjection) < Math.min(...candidateProjection)) return false
    }
  }
  return true
}

export async function findMatchingSpores(image: HTMLImageElement, reference: ReferenceFeatures, referenceBox: OrientedBox, tuning?: MatchingSettings): Promise<SporeMatchResult> {
  const cv = await loadOpenCv()
  const scale = Math.min(1, MAX_PROCESSING_SIDE / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas is unavailable')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)

  const source = cv.imread(canvas)
  try {
    return matchSporePixels(cv, source, reference, referenceBox, scale, undefined, { ...DEFAULT_CANDIDATE_PREPROCESSING, tuning })
  } finally {
    source.delete()
  }
}

export function correctCandidateIllumination(cv: OpenCv, gray: CvMat, referenceWidth: number): CvMat {
  const sigma = Math.max(3, referenceWidth)
  const reduction = Math.min(1, 8 / sigma)
  const small = new cv.Mat()
  const smooth = new cv.Mat()
  const background = new cv.Mat()
  const floatGray = new cv.Mat()
  const floatBackground = new cv.Mat()
  const difference = new cv.Mat()
  const corrected = new cv.Mat()
  try {
    cv.resize(gray, small, new cv.Size(Math.max(1, Math.round(gray.cols * reduction)), Math.max(1, Math.round(gray.rows * reduction))), 0, 0, cv.INTER_AREA)
    cv.GaussianBlur(small, smooth, new cv.Size(0, 0), sigma * reduction, sigma * reduction, cv.BORDER_REPLICATE)
    cv.resize(smooth, background, new cv.Size(gray.cols, gray.rows), 0, 0, cv.INTER_LINEAR)
    gray.convertTo(floatGray, cv.CV_32F)
    background.convertTo(floatBackground, cv.CV_32F)
    cv.subtract(floatGray, floatBackground, difference)
    difference.convertTo(corrected, cv.CV_8U, 1, 128)
    return corrected
  } catch (error) {
    corrected.delete()
    throw error
  } finally {
    small.delete()
    smooth.delete()
    background.delete()
    floatGray.delete()
    floatBackground.delete()
    difference.delete()
  }
}

export function matchSporePixels(cv: OpenCv, source: CvMat, reference: ReferenceFeatures, referenceBox: OrientedBox, scale = 1, observe?: MatchObserver, preprocessing: CandidatePreprocessing = {}): SporeMatchResult {
  const referenceArea = reference.area * scale * scale
  const tuning = preprocessing.tuning
  const relativeReference = tuning?.relativeContrast ? normalizeContrastHistogram(reference.histogram) : undefined
  const directLimits = tuning ? { ...DIRECT_LIMITS, minArea: 1 - tuning.sizeTolerance / 100, maxArea: 1 + tuning.sizeTolerance / 100 } : DIRECT_LIMITS
  const segmentLimits = tuning ? { ...WATERSHED_LIMITS, minArea: directLimits.minArea, maxArea: directLimits.maxArea } : WATERSHED_LIMITS
  const blockSize = Math.max(11, 2 * Math.round(reference.width * scale) + 1)
  const gray = new cv.Mat()
  const blurred = new cv.Mat()
  const otsuBinary = new cv.Mat()
  const edges = new cv.Mat()
  const adaptive = new cv.Mat()
  const combined = new cv.Mat()
  const filled = new cv.Mat(source.rows, source.cols, cv.CV_8UC1, new cv.Scalar(0))
  const outlineContours = new cv.MatVector()
  const blobContours = new cv.MatVector()
  const rimContours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3))
  const matches: SporeMatch[] = []
  const rejectedOutlines: GeometryPoint[][] = []
  let candidates = 0
  let directCandidates = 0
  let clusterCandidates = 0
  let corrected: CvMat | undefined

  const outlineOf = (contour: CvMat) => {
    const outline: GeometryPoint[] = []
    for (let index = 0; index < contour.data32S.length; index += 2) {
      outline.push({ x: (contour.data32S[index] + 0.5) / scale, y: (contour.data32S[index + 1] + 0.5) / scale })
    }
    return outline
  }
  const rejectOutline = (contour: CvMat) => {
    if (rejectedOutlines.length < 500 && cv.contourArea(contour) >= referenceArea * 0.1) rejectedOutlines.push(outlineOf(contour))
  }

  const trace = (contour: CvMat, stage: MatchTrace['stage'], kind: SporeMatch['source'], details: Partial<MatchTrace> = {}) => {
    if (!observe) return
    const box = rotatedRectBox(cv, cv.minAreaRect(contour))
    observe({
      stage, source: kind,
      box: { ...box, centerX: box.centerX / scale, centerY: box.centerY / scale, width: box.width / scale, height: box.height / scale },
      areaRatio: cv.contourArea(contour) / referenceArea,
      ...details,
    }, contour)
  }

  const evaluate = (contour: CvMat, limits: MatchLimits, kind: SporeMatch['source'], recovery?: SporeMatch['recovery']) => {
    const box = rotatedRectBox(cv, cv.minAreaRect(contour))
    if (box.height <= 0 || overlapsReference(box, referenceBox, scale)) {
      trace(contour, 'rejected', kind, { reason: box.height <= 0 ? 'zeroHeight' : 'referenceOverlap' })
      return false
    }
    const sourceBox = { ...box, centerX: box.centerX / scale, centerY: box.centerY / scale, width: box.width / scale, height: box.height / scale }
    if (recovery && matches.some((match) => boxIntersectionOverUnion(cv, sourceBox, match) >= 0.5)) return false
    const patch = extractPatch(cv, gray, box)
    let distance: number
    let relativeDistance: number | undefined
    try {
      const histogram = analyzeReferencePatch(cv, patch).histogram
      distance = bhattacharyyaDistance(histogram, reference.histogram)
      if (relativeReference && distance >= limits.maxDistance) {
        const relative = normalizeContrastHistogram(histogram)
        if (relative.span >= Math.max(4, relativeReference.span * 0.3)) relativeDistance = bhattacharyyaDistance(relative.histogram, relativeReference.histogram)
      }
    } finally {
      patch.delete()
    }
    const q = box.width / box.height
    const histogramPassed = distance < limits.maxDistance || (relativeDistance !== undefined && relativeDistance < limits.maxDistance)
    trace(contour, 'evaluated', kind, {
      distance, ...(relativeDistance === undefined ? {} : { relativeDistance }), histogramPassed,
      qPassed: Math.abs(q - reference.q) <= reference.q * limits.qTolerance,
    })
    if (!histogramPassed || Math.abs(q - reference.q) > reference.q * limits.qTolerance) {
      rejectOutline(contour)
      return false
    }
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
      outline: outlineOf(contour),
      ...(recovery ? { recovery } : distance >= limits.maxDistance ? { recovery: 'contrast' as const } : {}),
    })
    return true
  }

  const recoverRim = (contour: CvMat) => {
    if (!tuning?.recoverIncompleteRims || referenceArea <= 0 || cv.contourArea(contour) >= referenceArea * directLimits.minArea) return false
    const bounds = cv.boundingRect(contour)
    if (bounds.x <= 0 || bounds.y <= 0 || bounds.x + bounds.width >= source.cols || bounds.y + bounds.height >= source.rows) return false
    const box = rotatedRectBox(cv, cv.minAreaRect(contour))
    const q = box.width / box.height
    if (!Number.isFinite(q) || Math.abs(q - reference.q) > reference.q * directLimits.qTolerance || overlapsReference(box, referenceBox, scale)) return false
    const hull = new cv.Mat()
    try {
      cv.convexHull(contour, hull)
      const estimatedArea = cv.contourArea(hull)
      if (estimatedArea < 50 * scale * scale || areaGroup(estimatedArea, referenceArea, directLimits) !== 'direct') return false
      if (rimBoundarySupport(cv, contour, hull, Math.max(2, reference.height * 0.04) * scale) < 0.7) return false
      if (!evaluate(contour, directLimits, 'direct', 'rim')) return false
      candidates += 1
      directCandidates += 1
      return true
    } finally {
      hull.delete()
    }
  }

  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY)
    if (preprocessing.correctIllumination) corrected = correctCandidateIllumination(cv, gray, reference.width * scale)
    if (tuning?.smoothing === 0) (corrected ?? gray).copyTo(blurred)
    else if (tuning) {
      const sigma = Math.max(0.1, reference.height * scale * tuning.smoothing / 100)
      cv.GaussianBlur(corrected ?? gray, blurred, new cv.Size(0, 0), sigma, sigma, cv.BORDER_REPLICATE)
    } else cv.GaussianBlur(corrected ?? gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_REPLICATE)
    const otsu = cv.threshold(blurred, otsuBinary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU)
    cv.Canny(blurred, edges, otsu * 0.5, otsu)
    const adaptiveOffset = tuning ? (reference.polarity === 'dark' ? 10 - tuning.sensitivity : tuning.sensitivity) : 5
    cv.adaptiveThreshold(blurred, adaptive, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, reference.polarity === 'dark' ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY, blockSize, adaptiveOffset)
    if (preprocessing.mask === 'edges') edges.copyTo(combined)
    else if (preprocessing.mask === 'adaptive') adaptive.copyTo(combined)
    else cv.bitwise_or(edges, adaptive, combined)
    cv.morphologyEx(combined, combined, cv.MORPH_CLOSE, kernel)
    cv.findContours(combined, outlineContours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    // Spores are solid, so fill outlines before measuring area.
    cv.drawContours(filled, outlineContours, -1, new cv.Scalar(255), cv.FILLED)
    cv.findContours(filled, blobContours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    for (let index = 0; index < blobContours.size(); index += 1) {
      const contour = blobContours.get(index)
      try {
        trace(contour, 'generated', 'direct')
        const bounds = cv.boundingRect(contour)
        if (bounds.x <= 0 || bounds.y <= 0 || bounds.x + bounds.width >= source.cols || bounds.y + bounds.height >= source.rows) {
          trace(contour, 'rejected', 'direct', { reason: 'frame' })
          rejectOutline(contour)
          continue
        }
        trace(contour, 'framePassed', 'direct')
        const group = areaGroup(cv.contourArea(contour), referenceArea, directLimits)
        if (group === 'reject') {
          const ratio = cv.contourArea(contour) / referenceArea
          rejectOutline(contour)
          trace(contour, 'rejected', 'direct', { reason: ratio < NOISE_AREA_RATIO ? 'areaBelowNoise' : ratio > OVERSIZE_AREA_RATIO ? 'areaAboveMaximum' : 'areaBelowDirect' })
          continue
        }
        trace(contour, 'areaPassed', 'direct')
        candidates += 1
        if (group === 'direct') {
          directCandidates += 1
          trace(contour, 'geometry', 'direct')
          trace(contour, 'segmentAreaPassed', 'direct')
          evaluate(contour, directLimits, 'direct')
          continue
        }
        clusterCandidates += 1
        const segments = watershedSegments(cv, blurred, contour)
        if (!segments.length) {
          trace(contour, 'rejected', 'watershed', { reason: 'watershedNoSegments' })
          rejectOutline(contour)
        }
        for (const segment of segments) {
          try {
            trace(segment, 'geometry', 'watershed')
            if (areaGroup(cv.contourArea(segment), referenceArea, segmentLimits) === 'direct') {
              trace(segment, 'segmentAreaPassed', 'watershed')
              evaluate(segment, segmentLimits, 'watershed')
            } else {
              trace(segment, 'rejected', 'watershed', { reason: 'segmentArea' })
              rejectOutline(segment)
            }
          } finally {
            segment.delete()
          }
        }
      } finally {
        contour.delete()
      }
    }
    if (tuning?.recoverIncompleteRims) {
      for (let index = 0; index < blobContours.size(); index += 1) {
        const contour = blobContours.get(index)
        try {
          recoverRim(contour)
        } finally {
          contour.delete()
        }
      }
    }
    if (tuning?.recoverIncompleteRims && preprocessing.mask !== 'edges') {
      cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel)
      cv.findContours(edges, rimContours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
      for (let index = 0; index < rimContours.size(); index += 1) {
        const contour = rimContours.get(index)
        try {
          recoverRim(contour)
        } finally {
          contour.delete()
        }
      }
    }
  } finally {
    corrected?.delete()
    gray.delete()
    blurred.delete()
    otsuBinary.delete()
    edges.delete()
    adaptive.delete()
    combined.delete()
    filled.delete()
    outlineContours.delete()
    blobContours.delete()
    rimContours.delete()
    hierarchy.delete()
    kernel.delete()
  }
  return { matches, candidates, directCandidates, clusterCandidates, rejectedOutlines }
}
