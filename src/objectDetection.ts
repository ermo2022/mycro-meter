import { longAxisFirst, normalizeBoxAngle, type OrientedBox } from './boxGeometry'
import openCvUrl from '@techstark/opencv-js/dist/opencv.js?url'

export type ObjectPolarity = 'dark' | 'bright'
export type NoiseFilter = 'gaussian' | 'median' | 'bilateral'
export type DetectionRegion = { x: number; y: number; width: number; height: number }
export type DetectedObject = OrientedBox & { id: string; area: number; nearby?: boolean }
export type DetectionPreview = { original: HTMLCanvasElement; dark: HTMLCanvasElement; bright: HTMLCanvasElement }
type DetectionCandidate = DetectedObject & { clickDistance: number }

type OpenCvApi = typeof import('@techstark/opencv-js')
type OpenCvModule = OpenCvApi & {
  onRuntimeInitialized?: () => void
}

let openCvPromise: Promise<OpenCvApi> | undefined

async function loadOpenCv(): Promise<OpenCvApi> {
  if (!openCvPromise) {
    openCvPromise = (async () => {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = openCvUrl
        script.async = true
        script.onload = () => {
          script.remove()
          resolve()
        }
        script.onerror = () => {
          script.remove()
          reject(new Error('OpenCV could not be loaded'))
        }
        document.head.appendChild(script)
      })
      const runtime = await (globalThis as typeof globalThis & { cv?: OpenCvModule | Promise<OpenCvModule> }).cv
      if (!runtime) throw new Error('OpenCV runtime is unavailable')
      if (runtime.Mat) return runtime
      await new Promise<void>((resolve) => {
        runtime.onRuntimeInitialized = resolve
      })
      return runtime
    })().catch((error: unknown) => {
      openCvPromise = undefined
      throw error
    })
  }
  return openCvPromise
}

export async function detectObjects(
  image: HTMLImageElement,
  polarity: ObjectPolarity,
  minimumArea: number,
  sensitivity: number,
  region?: DetectionRegion | null,
  noiseFilter: NoiseFilter = 'gaussian',
): Promise<DetectedObject[]> {
  const result = await detectRegion(image, polarity, minimumArea, sensitivity, region, undefined, Infinity, undefined, noiseFilter)
  return result.boxes.map((box) => selectedObject(box))
}

export async function detectClickedObject(
  image: HTMLImageElement,
  point: { x: number; y: number },
  polarity: ObjectPolarity | 'auto',
  minimumArea: number,
  sensitivity: number,
  maximumArea = Infinity,
  noiseFilter: NoiseFilter = 'gaussian',
  recoverNearby = true,
): Promise<DetectedObject | null> {
  const maximumRadius = Math.max(image.naturalWidth, image.naturalHeight)
  for (let radius = Math.min(128, maximumRadius); ; radius = Math.min(radius * 2, maximumRadius)) {
    const region = clickedRegion(image, point, radius)
    const polarities: ObjectPolarity[] = polarity === 'auto' ? ['dark', 'bright'] : [polarity]
    const candidates: DetectionCandidate[] = []
    const nearbyCandidates: DetectionCandidate[] = []
    for (const candidatePolarity of polarities) {
      const result = await detectRegion(image, candidatePolarity, polarity === 'auto' ? 1 : minimumArea, sensitivity, region, point, polarity === 'auto' ? Infinity : maximumArea, undefined, noiseFilter, recoverNearby ? 16 : 4)
      if (!result.clippedTarget) {
        const direct = result.boxes.find((box) => box.clickDistance >= -4)
        if (direct) candidates.push(direct)
        if (recoverNearby && !result.clippedNearby) nearbyCandidates.push(...result.boxes.filter((box) =>
          box.clickDistance < -4 && box.area >= minimumArea && box.area <= maximumArea,
        ))
      }
    }
    candidates.sort((first, second) => first.area - second.area)
    const best = candidates[0]
    if (best && best.area >= minimumArea && best.area <= maximumArea) return selectedObject(best)
    nearbyCandidates.sort((first, second) => second.clickDistance - first.clickDistance)
    if (nearbyCandidates.length) {
      const nearest = nearbyCandidates[0]
      const alternative = nearbyCandidates[1]
      if (alternative && nearest.clickDistance - alternative.clickDistance < 4) return null
      return selectedObject(nearest, true)
    }
    if (best) return null
    if (radius === maximumRadius) return null
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

function selectedObject(candidate: DetectionCandidate, nearby = false): DetectedObject {
  const { clickDistance: _clickDistance, ...box } = candidate
  return { ...box, nearby }
}

function clickedRegion(image: HTMLImageElement, point: { x: number; y: number }, radius: number): DetectionRegion {
  const x = Math.max(0, Math.floor(point.x - radius))
  const y = Math.max(0, Math.floor(point.y - radius))
  return {
    x,
    y,
    width: Math.min(image.naturalWidth, Math.ceil(point.x + radius)) - x,
    height: Math.min(image.naturalHeight, Math.ceil(point.y + radius)) - y,
  }
}

export async function createDetectionPreview(
  image: HTMLImageElement,
  point: { x: number; y: number },
  sensitivity: number,
  noiseFilter: NoiseFilter = 'gaussian',
): Promise<DetectionPreview> {
  const region = clickedRegion(image, point, Math.min(128, Math.max(image.naturalWidth, image.naturalHeight)))
  const original = document.createElement('canvas')
  original.width = region.width
  original.height = region.height
  const context = original.getContext('2d')
  if (!context) throw new Error('Canvas is unavailable')
  context.drawImage(image, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height)
  const dark = document.createElement('canvas')
  const bright = document.createElement('canvas')
  await detectRegion(image, 'dark', 1, sensitivity, region, point, Infinity, dark, noiseFilter)
  await detectRegion(image, 'bright', 1, sensitivity, region, point, Infinity, bright, noiseFilter)
  return { original, dark, bright }
}

async function detectRegion(
  image: HTMLImageElement,
  polarity: ObjectPolarity,
  minimumArea: number,
  sensitivity: number,
  region?: DetectionRegion | null,
  target?: { x: number; y: number },
  maximumArea = Infinity,
  previewCanvas?: HTMLCanvasElement,
  noiseFilter: NoiseFilter = 'gaussian',
  targetTolerance = 4,
): Promise<{ boxes: DetectionCandidate[]; clippedTarget: boolean; clippedNearby: boolean }> {
  const cv = await loadOpenCv()
  const originalWidth = image.naturalWidth
  const originalHeight = image.naturalHeight
  const analysisRegion = region ?? { x: 0, y: 0, width: originalWidth, height: originalHeight }
  const resizeFactor = Math.min(1, 1800 / Math.max(analysisRegion.width, analysisRegion.height))
  const processingCanvas = document.createElement('canvas')
  processingCanvas.width = Math.max(1, Math.round(analysisRegion.width * resizeFactor))
  processingCanvas.height = Math.max(1, Math.round(analysisRegion.height * resizeFactor))

  const context = processingCanvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas is unavailable')
  context.drawImage(
    image,
    analysisRegion.x,
    analysisRegion.y,
    analysisRegion.width,
    analysisRegion.height,
    0,
    0,
    processingCanvas.width,
    processingCanvas.height,
  )

  const source = cv.imread(processingCanvas)
  const gray = new cv.Mat()
  const blurred = new cv.Mat()
  const binary = new cv.Mat()
  const closed = new cv.Mat()
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  const boxes: (Omit<DetectedObject, 'id'> & { clickDistance: number })[] = []
  let clippedTarget = false
  let clippedNearby = false
  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3))

  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY)
    if (noiseFilter === 'median') cv.medianBlur(gray, blurred, 3)
    else if (noiseFilter === 'bilateral') cv.bilateralFilter(gray, blurred, 5, 25, 3, cv.BORDER_DEFAULT)
    else cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT)
    const thresholdMode = polarity === 'dark' ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY
    const blockSize = 41
    const adaptiveOffset = polarity === 'dark' ? 12 - sensitivity : target ? sensitivity - 12 : sensitivity - 1
    cv.adaptiveThreshold(blurred, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, thresholdMode, blockSize, adaptiveOffset)
    cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel)
    if (previewCanvas) {
      cv.imshow(previewCanvas, closed)
      return { boxes: [], clippedTarget: false, clippedNearby: false }
    }
    cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    const minimumProcessingArea = Math.max(1, minimumArea * resizeFactor * resizeFactor)
    const maximumProcessingArea = maximumArea * resizeFactor * resizeFactor
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index)
      const clickDistance = target ? cv.pointPolygonTest(contour, new cv.Point(
        (target.x - analysisRegion.x) * resizeFactor,
        (target.y - analysisRegion.y) * resizeFactor,
      ), true) / resizeFactor : 0
      const area = cv.contourArea(contour)
      const bounds = cv.boundingRect(contour)
      try {
        const touchesFrame = bounds.x <= 0 || bounds.y <= 0 || bounds.x + bounds.width >= processingCanvas.width || bounds.y + bounds.height >= processingCanvas.height
        if (target && clickDistance < -targetTolerance) continue
        const touchesCrop = (bounds.x <= 0 && analysisRegion.x > 0) ||
          (bounds.y <= 0 && analysisRegion.y > 0) ||
          (bounds.x + bounds.width >= processingCanvas.width && analysisRegion.x + analysisRegion.width < originalWidth) ||
          (bounds.y + bounds.height >= processingCanvas.height && analysisRegion.y + analysisRegion.height < originalHeight)
        if (target && touchesCrop) {
          if (clickDistance >= -4) clippedTarget = true
          else clippedNearby = true
          continue
        }
        if (target && bounds.x <= 0 && bounds.y <= 0 && bounds.x + bounds.width >= processingCanvas.width && bounds.y + bounds.height >= processingCanvas.height) continue
        if (area < minimumProcessingArea || area > maximumProcessingArea || (!target && touchesFrame)) continue
        const box = contourBox(cv, contour)
        if (box.width < 3 || box.height < 3) continue
        boxes.push({
          centerX: analysisRegion.x + box.centerX / resizeFactor,
          centerY: analysisRegion.y + box.centerY / resizeFactor,
          width: box.width / resizeFactor,
          height: box.height / resizeFactor,
          angle: box.angle,
          area: area / (resizeFactor * resizeFactor),
          clickDistance,
        })
      } finally {
        contour.delete()
      }
    }
  } finally {
    source.delete()
    gray.delete()
    blurred.delete()
    binary.delete()
    closed.delete()
    contours.delete()
    hierarchy.delete()
    kernel.delete()
  }

  boxes.sort(target
    ? (first, second) => Number(second.clickDistance >= 0) - Number(first.clickDistance >= 0) ||
      (first.clickDistance >= 0 ? first.area - second.area : second.clickDistance - first.clickDistance)
    : (first, second) => first.centerY - second.centerY || first.centerX - second.centerX)
  return {
    boxes: boxes.slice(0, 500).map((box, index) => ({ ...box, id: `object-${index + 1}` })),
    clippedTarget,
    clippedNearby,
  }
}

function contourBox(cv: OpenCvApi, contour: InstanceType<OpenCvApi['Mat']>): OrientedBox {
  const moments = cv.moments(contour, false)
  const spread = moments.mu20 + moments.mu02
  const difference = Math.hypot(moments.mu20 - moments.mu02, 2 * moments.mu11)
  if (spread > 0 && difference / spread >= 0.1) {
    const radians = Math.atan2(2 * moments.mu11, moments.mu20 - moments.mu02) / 2
    const cosine = Math.cos(radians)
    const sine = Math.sin(radians)
    const originX = moments.m10 / moments.m00
    const originY = moments.m01 / moments.m00
    let minimumX = Infinity
    let maximumX = -Infinity
    let minimumY = Infinity
    let maximumY = -Infinity
    const points = contour.data32S
    for (let index = 0; index < points.length; index += 2) {
      const offsetX = points[index] - originX
      const offsetY = points[index + 1] - originY
      const projectedX = offsetX * cosine + offsetY * sine
      const projectedY = -offsetX * sine + offsetY * cosine
      minimumX = Math.min(minimumX, projectedX)
      maximumX = Math.max(maximumX, projectedX)
      minimumY = Math.min(minimumY, projectedY)
      maximumY = Math.max(maximumY, projectedY)
    }
    const middleX = (minimumX + maximumX) / 2
    const middleY = (minimumY + maximumY) / 2
    return longAxisFirst({
      centerX: originX + middleX * cosine - middleY * sine,
      centerY: originY + middleX * sine + middleY * cosine,
      width: maximumX - minimumX,
      height: maximumY - minimumY,
      angle: normalizeBoxAngle(radians * 180 / Math.PI),
    })
  }

  const rect = cv.minAreaRect(contour)
  const corners = cv.boxPoints(rect)
  const edges = corners.map((corner, index) => {
    const next = corners[(index + 1) % corners.length]
    const offsetX = next.x - corner.x
    const offsetY = next.y - corner.y
    return { offsetX, offsetY, length: Math.hypot(offsetX, offsetY) }
  })
  const widthAxis = edges.reduce((closest, edge) =>
    Math.abs(edge.length - rect.size.width) < Math.abs(closest.length - rect.size.width) ? edge : closest,
  )
  return longAxisFirst({
    centerX: rect.center.x,
    centerY: rect.center.y,
    width: rect.size.width,
    height: rect.size.height,
    angle: normalizeBoxAngle(Math.atan2(widthAxis.offsetY, widthAxis.offsetX) * 180 / Math.PI),
  })
}