import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent, type WheelEvent } from 'react'
import * as UTIF from 'utif'
import { createDetectionPreview, detectClickedObject, type DetectionPreview, type DetectionRegion, type NoiseFilter } from './objectDetection'
import { boxBounds, boxContainsPoint, boxCorners, boxHandles, constrainBoxToImage, longAxisFirst, normalizeOrientedBox, resizeOrientedBox, rotateOrientedBox, swapBoxAxes, type BoxHandle, type OrientedBox } from './boxGeometry'
import { MAX_SESSION_CSV_BYTES, MAX_SESSION_IMAGE_PIXELS, measurementSetBoxes, measurementSetCsv, parseSessionCsv, rawMeasurementsCsv, sessionCsv, units, type Calibration, type Measurement, type MeasurementSession, type MeasurementSetImage, type Point, type Unit } from './measurementCsv'

type BoxRectangle = OrientedBox
type BoxEditorState = { objectId: string; measurementId: number | null; rect: BoxRectangle; nearby?: boolean }
type EditorTransform = { cropX: number; cropY: number; cropWidth: number; cropHeight: number; scale: number; offsetX: number; offsetY: number }
type EditorDrag = { handle: BoxHandle; rect: BoxRectangle; start: Point; offset: Point }
type CalibrationDraft = { start: Point; end: Point }
type Tool = 'measure' | 'calibrate' | 'select' | 'pan'
type Language = string
type LocaleData = {
  languageName: string
  messages: Record<string, string>
  statuses: Record<string, string>
  statusTemplates: Record<string, string>
}

const localeModules = import.meta.glob<LocaleData>('./locales/*.json', { eager: true, import: 'default' })
const locales = Object.fromEntries(Object.entries(localeModules).map(([path, locale]) => [
  path.replace(/^.*\/([^/]+)\.json$/, '$1'),
  locale,
])) as Record<Language, LocaleData>

function formatMessage(template: string, values: Record<string, string | number> = {}) {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => String(values[key] ?? ''))
}

function translateStatus(status: string, locale: LocaleData) {
  const exactTranslation = locale.statuses[status] ?? locales.en.statuses[status]
  if (exactTranslation) return exactTranslation

  const render = (key: string, values: Record<string, string | number>) => formatMessage(
    locale.statusTemplates[key] ?? locales.en.statusTemplates[key] ?? status,
    values,
  )
  const restored = status.match(/^Restored (\d+) measurements( · calibration required)?$/)
  if (restored) return render('restored', {
    count: restored[1],
    calibrationMessage: restored[2] ? locale.statusTemplates.calibrationRequired ?? '' : '',
  })
  const scaleSet = status.match(/^Scale set · (.+) per (.+)$/)
  if (scaleSet) return render('scaleSet', { unit: scaleSet[1], length: scaleSet[2] })
  const savedSet = status.match(/^(.*) saved to measurement set$/)
  if (savedSet) return render('savedSet', { imageName: savedSet[1] })
  const acceptedBox = status.match(/^Box accepted · (.*)$/)
  if (acceptedBox) return render('boxAccepted', { dimensions: acceptedBox[1] })
  const pendingSession = status.match(/^Session read · open (.*) to restore (\d+) measurements$/)
  if (pendingSession) return render('pendingSession', { imageName: pendingSession[1], count: pendingSession[2] })
  const imageMismatch = status.match(/^Image is (.*) px, session expects (.*) px · open (.*)$/)
  if (imageMismatch) return render('imageMismatch', { actual: imageMismatch[1], expected: imageMismatch[2], imageName: imageMismatch[3] })
  const invalidCsvValue = status.match(/^Invalid (.+) in CSV row (\d+)$/)
  if (invalidCsvValue) return render('invalidCsvValue', { field: invalidCsvValue[1], row: invalidCsvValue[2] })
  const unsupportedCsvUnit = status.match(/^Unsupported unit "(.+)" in CSV$/)
  if (unsupportedCsvUnit) return render('unsupportedCsvUnit', { unit: unsupportedCsvUnit[1] })
  const unknownCsvType = status.match(/^Unknown measurement type in CSV row (\d+)$/)
  if (unknownCsvType) return render('unknownCsvType', { row: unknownCsvType[1] })
  const invalidCsvBox = status.match(/^Invalid box size in CSV row (\d+)$/)
  if (invalidCsvBox) return render('invalidCsvBox', { row: invalidCsvBox[1] })
  return status
}
const MAX_IMAGE_FILE_BYTES = 100 * 1024 * 1024

async function imageFileToUrl(file: File) {
  if (file.size > MAX_IMAGE_FILE_BYTES) throw new Error('Image file exceeds the 100 MiB limit')
  if (!/\.tiff?$/i.test(file.name) && file.type !== 'image/tiff') return URL.createObjectURL(file)
  const buffer = await file.arrayBuffer()
  const pages = UTIF.decode(buffer)
  const page = pages[0]
  if (!page) throw new Error('No TIFF image page found')
  if (!Number.isInteger(page.width) || !Number.isInteger(page.height) || page.width <= 0 || page.height <= 0 || page.width * page.height > MAX_SESSION_IMAGE_PIXELS) {
    throw new Error('Image dimensions are invalid or exceed 40 megapixels')
  }
  UTIF.decodeImage(buffer, page)
  const pixels = UTIF.toRGBA8(page)
  const canvas = document.createElement('canvas')
  canvas.width = page.width
  canvas.height = page.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas is unavailable')
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels), page.width, page.height), 0, 0)
  const png = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('TIFF conversion failed')), 'image/png')
  })
  return URL.createObjectURL(png)
}

async function downloadCsv(csv: string, fileName: string) {
  const blob = new Blob([csv], { type: 'text/csv' })
  const saveWindow = window as Window & {
    showSaveFilePicker?: (options: {
      id: string
      suggestedName: string
      types: { description: string; accept: Record<string, string[]> }[]
    }) => Promise<{
      createWritable: () => Promise<{
        write: (data: Blob) => Promise<void>
        close: () => Promise<void>
      }>
    }>
  }
  if (saveWindow.showSaveFilePicker) {
    try {
      const handle = await saveWindow.showSaveFilePicker({
        id: 'mycrometer-csv',
        suggestedName: fileName,
        types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }],
      })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      throw error
    }
    return
  }
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = fileName
  link.click()
  URL.revokeObjectURL(link.href)
}

function distance(a: Point, b: Point) {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function regionBetween(start: Point, end: Point): DetectionRegion {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function clampZoom(value: number) {
  return clamp(value, 0.25, 20)
}

const micrometresPerUnit: Record<Unit, number> = { 'µm': 1, mm: 1000, nm: 0.001 }

function formatDetectionDimension(value: number) {
  return String(Number(value.toPrecision(6)))
}

function detectionAreaDefaults(calibration: Calibration, imageWidth: number) {
  const pixelsPerMicrometre = calibration.pixelsPerUnit / micrometresPerUnit[calibration.unit]
  const tenthImageWidthMicrometres = imageWidth * 0.1 / pixelsPerMicrometre
  const unit: Unit = tenthImageWidthMicrometres < 1 ? 'nm' : tenthImageWidthMicrometres >= 1000 ? 'mm' : 'µm'
  const minimumSide = 3 / micrometresPerUnit[unit]
  const maximumSide = 50 / micrometresPerUnit[unit]
  return {
    unit,
    minimumWidth: formatDetectionDimension(minimumSide),
    minimumHeight: formatDetectionDimension(minimumSide),
    maximumWidth: formatDetectionDimension(maximumSide),
    maximumHeight: formatDetectionDimension(maximumSide),
  }
}

function boxFromRegion(region: DetectionRegion): BoxRectangle {
  return longAxisFirst({
    centerX: region.x + region.width / 2,
    centerY: region.y + region.height / 2,
    width: region.width,
    height: region.height,
    angle: 0,
  })
}

type SummaryStats = { n: number; mean: number; sampleSd: number | null; min: number; max: number; median: number; p10: number; p90: number }

function summarize(values: number[]): SummaryStats {
  if (!values.length) return { n: 0, mean: 0, sampleSd: null, min: 0, max: 0, median: 0, p10: 0, p90: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  const sampleSd = values.length < 2
    ? null
    : Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1))
  const percentile = (fraction: number) => {
    const position = (sorted.length - 1) * fraction
    const lower = Math.floor(position)
    const upper = Math.ceil(position)
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
  }
  return {
    n: values.length,
    mean,
    sampleSd,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: percentile(0.5),
    p10: percentile(0.1),
    p90: percentile(0.9),
  }
}

function formatSummary(stats: SummaryStats, unit: string) {
  if (!stats.n) return '—'
  if (stats.sampleSd === null) return `${formatMycologicalNumber(stats.mean)} (SD n/a)${unit ? ` ${unit}` : ''}`
  return `${formatMycologicalNumber(stats.mean)} ± ${formatMycologicalNumber(stats.sampleSd)}${unit ? ` ${unit}` : ''}`
}

function formatDeciles(stats: SummaryStats, unit: string) {
  if (!stats.n) return '—'
  const range = formatMycologicalRange(stats)
  return `${range}${unit ? ` ${unit}` : ''}`
}

function formatMycologicalNumber(value: number) {
  return Number(value.toFixed(1)).toString()
}

function formatMycologicalMedian(value: number) {
  return formatMycologicalNumber(value)
}

function formatMycologicalRange(stats: SummaryStats) {
  const lower = stats.min < stats.p10 ? `(${formatMycologicalNumber(stats.min)}) ` : ''
  const upper = stats.max > stats.p90 ? ` (${formatMycologicalNumber(stats.max)})` : ''
  return `${lower}${formatMycologicalNumber(stats.p10)}–${formatMycologicalNumber(stats.p90)}${upper}`
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const measurementGestureRef = useRef<{ pointerId: number; start: Point; moved: boolean } | null>(null)
  const calibrationHandleRef = useRef<{ pointerId: number; key: 'start' | 'end' } | null>(null)
  const touchPointersRef = useRef(new Map<number, Point>())
  const pinchRef = useRef<{ distance: number; mid: Point; zoom: number; pan: Point } | null>(null)
  const calibrationTapRef = useRef<{ pointerId: number; start: Point; point: Point } | null>(null)
  const detectionEpochRef = useRef(0)
  const pointDetectionRef = useRef(false)
  const lastDetectionPointRef = useRef<Point | null>(null)
  const previewButtonRef = useRef<HTMLButtonElement>(null)
  const [language, setLanguage] = useState<Language>(() => {
    const savedLanguage = window.localStorage.getItem('mycrometer-language')
    return savedLanguage && locales[savedLanguage] ? savedLanguage : 'en'
  })
  const [imageUrl, setImageUrl] = useState('')
  const [imageName, setImageName] = useState('')
  const [imageSize, setImageSize] = useState<Point | null>(null)
  const [tool, setTool] = useState<Tool>('measure')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 })
  const [calibration, setCalibration] = useState<Calibration | null>(null)
  const [pendingImport, setPendingImport] = useState<MeasurementSession | null>(null)
  const [calibrationDraft, setCalibrationDraft] = useState<CalibrationDraft | null>(null)
  const [calibrationLocked, setCalibrationLocked] = useState(false)
  const [calibrationEntering, setCalibrationEntering] = useState(false)
  const [knownLength, setKnownLength] = useState('')
  const [calibrationUnit, setCalibrationUnit] = useState<Unit>('µm')
  const [measurements, setMeasurements] = useState<Measurement[]>([])
  const [imageId, setImageId] = useState('')
  const [measurementSet, setMeasurementSet] = useState<MeasurementSetImage[]>([])
  const [setUnit, setSetUnit] = useState<Unit>('µm')
  const [boxEditor, setBoxEditor] = useState<BoxEditorState | null>(null)
  const [detectionUnit, setDetectionUnit] = useState<Unit>('µm')
  const [minimumWidth, setMinimumWidth] = useState('3')
  const [minimumHeight, setMinimumHeight] = useState('3')
  const [maximumWidth, setMaximumWidth] = useState('50')
  const [maximumHeight, setMaximumHeight] = useState('50')
  const [detectionSensitivity, setDetectionSensitivity] = useState(8)
  const [noiseFilter, setNoiseFilter] = useState<NoiseFilter>('gaussian')
  const [recoverNearby, setRecoverNearby] = useState(true)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [manualStart, setManualStart] = useState<Point | null>(null)
  const [manualDraft, setManualDraft] = useState<DetectionRegion | null>(null)
  const [dragOrigin, setDragOrigin] = useState<Point | null>(null)
  const [status, setStatus] = useState('Open an image to begin')
  const [detectionNotice, setDetectionNotice] = useState<{ imageUrl: string } | null>(null)
  const locale = locales[language] ?? locales.en
  const t = (key: string, values: Record<string, string | number> = {}) => formatMessage(
    locale.messages[key] ?? locales.en.messages[key] ?? key,
    values,
  )
  const interactionRef = useRef({ tool, calibration })
  interactionRef.current = { tool, calibration }
  const detectionPixelsPerUnit = calibration
    ? calibration.pixelsPerUnit * micrometresPerUnit[detectionUnit] / micrometresPerUnit[calibration.unit]
    : 0
  const minimumWidthValue = Number(minimumWidth)
  const minimumHeightValue = Number(minimumHeight)
  const maximumWidthValue = Number(maximumWidth)
  const maximumHeightValue = Number(maximumHeight)
  const minimumObjectArea = Math.ceil(minimumWidthValue * minimumHeightValue * detectionPixelsPerUnit ** 2 / 50) * 50
  const maximumObjectArea = maximumWidthValue * maximumHeightValue * detectionPixelsPerUnit ** 2
  const detectionLimitsValid = [minimumWidth, minimumHeight, maximumWidth, maximumHeight].every((value) => value.trim() !== '') &&
    [minimumWidthValue, minimumHeightValue, maximumWidthValue, maximumHeightValue, minimumObjectArea, maximumObjectArea].every(Number.isFinite) &&
    minimumWidthValue > 0 && minimumHeightValue > 0 && maximumWidthValue > 0 && maximumHeightValue > 0 &&
    maximumObjectArea >= minimumObjectArea

  const applyDetectionAreaDefaults = (nextCalibration: Calibration, imageWidth: number) => {
    const defaults = detectionAreaDefaults(nextCalibration, imageWidth)
    setDetectionUnit(defaults.unit)
    setMinimumWidth(defaults.minimumWidth)
    setMinimumHeight(defaults.minimumHeight)
    setMaximumWidth(defaults.maximumWidth)
    setMaximumHeight(defaults.maximumHeight)
  }

  const changeDetectionUnit = (nextUnit: Unit) => {
    const convert = (value: string) => value.trim() === ''
      ? value
      : String(Number(value) * micrometresPerUnit[detectionUnit] / micrometresPerUnit[nextUnit])
    setMinimumWidth(convert(minimumWidth))
    setMinimumHeight(convert(minimumHeight))
    setMaximumWidth(convert(maximumWidth))
    setMaximumHeight(convert(maximumHeight))
    setDetectionUnit(nextUnit)
  }

  useEffect(() => {
    window.localStorage.setItem('mycrometer-language', language)
    document.documentElement.lang = language
  }, [language])

  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl)
    }
  }, [imageUrl])

  useEffect(() => {
    if (!detectionNotice) return
    const timeout = window.setTimeout(() => setDetectionNotice(null), 4500)
    return () => window.clearTimeout(timeout)
  }, [detectionNotice])

  useEffect(() => {
    const canvas = canvasRef.current
    const view = viewRef.current
    const image = imageRef.current
    if (!canvas || !view || !image || !imageSize) return

    const draw = () => {
      const bounds = view.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(bounds.width * dpr))
      canvas.height = Math.max(1, Math.round(bounds.height * dpr))
      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, bounds.width, bounds.height)

      const fitScale = Math.min((bounds.width - 64) / imageSize.x, (bounds.height - 64) / imageSize.y)
      const scale = Math.max(0.01, fitScale * zoom)
      const width = imageSize.x * scale
      const height = imageSize.y * scale
      const left = (bounds.width - width) / 2 + pan.x
      const top = (bounds.height - height) / 2 + pan.y
      context.drawImage(image, left, top, width, height)

      const imageToCanvas = (point: Point) => ({ x: left + point.x * scale, y: top + point.y * scale })
      const drawBox = (box: BoxRectangle, color: string, lineWidth: number, dashed = false) => {
        const corners = boxCorners(box).map(imageToCanvas)
        context.beginPath()
        context.moveTo(corners[0].x, corners[0].y)
        corners.slice(1).forEach((point) => context.lineTo(point.x, point.y))
        context.closePath()
        context.strokeStyle = color
        context.lineWidth = lineWidth
        context.setLineDash(dashed ? [5, 4] : [])
        context.stroke()
        context.setLineDash([])
      }
      const drawRegion = (region: DetectionRegion, color: string) => {
        const topLeft = imageToCanvas({ x: region.x, y: region.y })
        context.strokeStyle = color
        context.lineWidth = 2
        context.setLineDash([7, 5])
        context.strokeRect(topLeft.x, topLeft.y, region.width * scale, region.height * scale)
        context.setLineDash([])
      }
      const drawLine = (start: Point, end: Point, color: string, dashed = false) => {
        const a = imageToCanvas(start)
        const b = imageToCanvas(end)
        context.beginPath()
        context.setLineDash(dashed ? [7, 5] : [])
        context.strokeStyle = color
        context.lineWidth = 2
        context.moveTo(a.x, a.y)
        context.lineTo(b.x, b.y)
        context.stroke()
        context.setLineDash([])
        for (const point of [a, b]) {
          context.beginPath()
          context.fillStyle = color
          context.arc(point.x, point.y, 4, 0, Math.PI * 2)
          context.fill()
        }
      }

      if (manualDraft) drawRegion(manualDraft, '#c54831')

      measurements.forEach((measurement, index) => {
        let midpoint: Point
        let value: string
        if (measurement.kind === 'distance') {
          drawLine(measurement.start, measurement.end, index === measurements.length - 1 ? '#c54831' : '#d09b28')
          midpoint = imageToCanvas({
            x: (measurement.start.x + measurement.end.x) / 2,
            y: (measurement.start.y + measurement.end.y) / 2,
          })
          value = calibration ? `${formatLength(measurement.pixels / calibration.pixelsPerUnit)} ${calibration.unit}` : `${measurement.pixels.toFixed(1)} px`
        } else {
          const box = normalizeOrientedBox(measurement.rect)
          drawBox(box, '#c54831', 2)
          midpoint = imageToCanvas({ x: box.centerX, y: box.centerY })
          value = calibration
            ? `${formatLength(box.width / calibration.pixelsPerUnit)} × ${formatLength(box.height / calibration.pixelsPerUnit)} ${calibration.unit} · ${box.angle.toFixed(1)}°`
            : `${box.width.toFixed(0)} × ${box.height.toFixed(0)} px · ${box.angle.toFixed(1)}°`
        }
        context.font = '600 12px "IBM Plex Mono", monospace'
        const labelWidth = context.measureText(value).width + 12
        context.fillStyle = '#102522'
        context.fillRect(midpoint.x - labelWidth / 2, midpoint.y - 22, labelWidth, 20)
        context.fillStyle = '#f8f6e8'
        context.textAlign = 'center'
        context.fillText(value, midpoint.x, midpoint.y - 8)
      })
      if (calibrationDraft) drawLine(calibrationDraft.start, calibrationDraft.end, '#197b66', true)
    }

    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(view)
    return () => observer.disconnect()
  }, [imageSize, zoom, pan, measurements, manualDraft, calibration, calibrationDraft, tool])

  const applySession = (session: MeasurementSession) => {
    detectionEpochRef.current += 1
    measurementGestureRef.current = null
    setCalibration(session.calibration)
    if (session.calibration) applyDetectionAreaDefaults(session.calibration, session.imageWidth)
    setCalibrationDraft(null)
    setCalibrationLocked(false)
    setManualStart(null)
    setManualDraft(null)
    setTool(session.calibration ? 'measure' : 'calibrate')
    setMeasurements(session.measurements)
    setBoxEditor(null)
    setPendingImport(null)
    setStatus(`Restored ${session.measurements.length} measurements${session.calibration ? '' : ' · calibration required'}`)
  }

  const loadImage = (url: string, fileName: string, session?: MeasurementSession | null) => {
    const image = new Image()
    image.onload = () => {
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0 || image.naturalWidth * image.naturalHeight > MAX_SESSION_IMAGE_PIXELS) {
        URL.revokeObjectURL(url)
        setStatus('Image dimensions are invalid or exceed 40 megapixels')
        return
      }
      detectionEpochRef.current += 1
      measurementGestureRef.current = null
      imageRef.current = image
      setImageSize({ x: image.naturalWidth, y: image.naturalHeight })
      setImageUrl(url)
      lastDetectionPointRef.current = null
      setPreviewOpen(false)
      setImageName(fileName)
      setImageId(crypto.randomUUID())
      setMeasurements([])
      setBoxEditor(null)
      setCalibration(null)
      setCalibrationDraft(null)
      setCalibrationLocked(false)
      setTool('calibrate')
      setManualStart(null)
      setManualDraft(null)
      setZoom(1)
      setPan({ x: 0, y: 0 })
      if (!session) {
        setStatus('Calibration required · click two points on a known scale bar')
      } else if (session.imageWidth === image.naturalWidth && session.imageHeight === image.naturalHeight) {
        applySession(session)
      } else {
        setStatus(`Image is ${image.naturalWidth} × ${image.naturalHeight} px, session expects ${session.imageWidth} × ${session.imageHeight} px · open ${session.imageName}`)
      }
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      setStatus('That image could not be opened')
    }
    image.src = url
  }

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setStatus('Choose an image file')
      return
    }
    try {
      loadImage(await imageFileToUrl(file), file.name, pendingImport)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'That image could not be decoded')
    }
    event.target.value = ''
  }

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    const csvFile = files.find((file) => /\.csv$/i.test(file.name) || file.type === 'text/csv')
    if (!csvFile) {
      setStatus('Choose a Mycrometer session CSV')
      return
    }
    if (csvFile.size > MAX_SESSION_CSV_BYTES) {
      setStatus('Session CSV exceeds the 10 MiB limit')
      return
    }
    let session: MeasurementSession
    try {
      session = parseSessionCsv(await csvFile.text())
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'That CSV could not be read')
      return
    }
    const imageFiles = files.filter((file) => file !== csvFile && file.type.startsWith('image/'))
    const imageFile = imageFiles.find((file) => file.name === session.imageName) ?? (imageFiles.length === 1 ? imageFiles[0] : undefined)
    if (imageFile) {
      try {
        loadImage(await imageFileToUrl(imageFile), imageFile.name, session)
      } catch {
        setStatus('That image could not be decoded')
      }
      return
    }
    if (imageRef.current && imageName === session.imageName && imageSize?.x === session.imageWidth && imageSize?.y === session.imageHeight) {
      applySession(session)
      return
    }
    setPendingImport(session)
    setStatus(`Session read · open ${session.imageName} to restore ${session.measurements.length} measurements`)
    // Browsers cannot open files by path, so ask the user to pick the image.
    fileInputRef.current?.click()
  }

  const unloadImage = () => {
    detectionEpochRef.current += 1
    measurementGestureRef.current = null
    imageRef.current = null
    setPendingImport(null)
    setImageUrl('')
    setImageName('')
    setImageSize(null)
    setCalibration(null)
    setCalibrationDraft(null)
    setCalibrationLocked(false)
    setMeasurements([])
    setBoxEditor(null)
    setManualStart(null)
    setManualDraft(null)
    setDragOrigin(null)
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setTool('measure')
    setStatus('Image unloaded · open an image to begin')
  }

  const toImagePoint = (event: PointerEvent<HTMLCanvasElement>): Point | null => {
    const canvas = canvasRef.current
    if (!canvas || !imageSize || !viewRef.current) return null
    const bounds = viewRef.current.getBoundingClientRect()
    const fitScale = Math.min((bounds.width - 64) / imageSize.x, (bounds.height - 64) / imageSize.y)
    const scale = Math.max(0.01, fitScale * zoom)
    const left = (bounds.width - imageSize.x * scale) / 2 + pan.x
    const top = (bounds.height - imageSize.y * scale) / 2 + pan.y
    const point = { x: (event.clientX - bounds.left - left) / scale, y: (event.clientY - bounds.top - top) / scale }
    if (point.x < 0 || point.y < 0 || point.x > imageSize.x || point.y > imageSize.y) return null
    return point
  }

  const detectAtPoint = async (point: Point) => {
    const image = imageRef.current
    if (!image || !calibration || detecting || pointDetectionRef.current) return
    if (!detectionLimitsValid) {
      setStatus('Invalid detection limits · check minimum and maximum object area')
      return
    }
    const epoch = detectionEpochRef.current
    const isCurrent = () => imageRef.current === image && detectionEpochRef.current === epoch &&
      interactionRef.current.calibration === calibration && interactionRef.current.tool === 'measure'
    pointDetectionRef.current = true
    lastDetectionPointRef.current = point
    setDetecting(true)
    setStatus('Finding the clicked object…')
    try {
      const object = await detectClickedObject(image, point, 'auto', minimumObjectArea, detectionSensitivity, maximumObjectArea, noiseFilter, recoverNearby)
      if (!isCurrent()) return
      if (!object) {
        setStatus('No object found at that point · try another point or drag a manual box')
        setDetectionNotice({ imageUrl })
        return
      }
      const objectId = `clicked-${crypto.randomUUID()}`
      setBoxEditor({ objectId, measurementId: null, rect: object, nearby: object.nearby })
      setStatus(object.nearby ? 'Nearby object selected · review the box before accepting' : 'Review the detected box · accept to measure or cancel to discard')
    } catch {
      if (isCurrent()) setStatus('Detection failed · try again or drag a manual box')
    } finally {
      pointDetectionRef.current = false
      setDetecting(false)
    }
  }

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch') {
      touchPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (touchPointersRef.current.size >= 2) {
        const [a, b] = [...touchPointersRef.current.values()]
        pinchRef.current = { distance: Math.max(1, distance(a, b)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, zoom, pan }
        measurementGestureRef.current = null
        calibrationHandleRef.current = null
        calibrationTapRef.current = null
        setDragOrigin(null)
        setManualStart(null)
        setManualDraft(null)
        return
      }
    }
    if (!calibration && tool !== 'calibrate' && tool !== 'pan') return
    setDetectionNotice(null)
    if (tool === 'pan' || event.button === 1) {
      setDragOrigin({ x: event.clientX - pan.x, y: event.clientY - pan.y })
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    if (event.button !== 0 || detecting) return
    const point = toImagePoint(event)
    if (!point) return
    if (tool === 'select') {
      const measuredBox = [...measurements].reverse().find((measurement): measurement is Extract<Measurement, { kind: 'box' }> => {
        return measurement.kind === 'box'
          && boxContainsPoint(measurement.rect, point)
      })
      if (measuredBox) {
        setBoxEditor({ objectId: measuredBox.objectId, measurementId: measuredBox.id, rect: measuredBox.rect })
        return
      }
      setStatus('Click inside a saved measurement box')
    } else if (tool === 'calibrate') {
      if (calibrationDraft && calibrationLocked && viewRef.current && imageSize) {
        const bounds = viewRef.current.getBoundingClientRect()
        const scale = Math.max(0.01, Math.min((bounds.width - 64) / imageSize.x, (bounds.height - 64) / imageSize.y) * zoom)
        const startGap = distance(point, calibrationDraft.start) * scale
        const endGap = distance(point, calibrationDraft.end) * scale
        const grabRadius = 32
        if (Math.min(startGap, endGap) <= grabRadius) {
          calibrationHandleRef.current = { pointerId: event.pointerId, key: startGap <= endGap ? 'start' : 'end' }
          event.currentTarget.setPointerCapture(event.pointerId)
        }
        return
      }
      if (!calibrationDraft || !calibrationLocked) {
        // Touch commits on release so a pinch started by a second finger doesn't drop a point.
        if (event.pointerType === 'touch') calibrationTapRef.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, point }
        else placeCalibrationPoint(point)
      }
    } else if (tool === 'measure') {
      measurementGestureRef.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, moved: false }
      setManualStart(point)
      setManualDraft({ x: point.x, y: point.y, width: 0, height: 0 })
      event.currentTarget.setPointerCapture(event.pointerId)
      setStatus('Drag to draw a manual measurement box')
    }
  }

  const placeCalibrationPoint = (point: Point) => {
    if (!calibrationDraft) {
      setCalibrationDraft({ start: point, end: point })
      setCalibrationLocked(false)
    } else if (!calibrationLocked) {
      setCalibrationDraft({ ...calibrationDraft, end: point })
      setCalibrationLocked(true)
      setCalibrationEntering(false)
      setKnownLength('')
      setStatus('Position both ends precisely (pinch to zoom, drag with two fingers), then enter the distance')
    }
  }

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch' && touchPointersRef.current.has(event.pointerId)) {
      touchPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      const pinch = pinchRef.current
      if (pinch && touchPointersRef.current.size >= 2 && viewRef.current) {
        const [a, b] = [...touchPointersRef.current.values()]
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        const bounds = viewRef.current.getBoundingClientRect()
        const nextZoom = clampZoom(pinch.zoom * distance(a, b) / pinch.distance)
        const ratio = nextZoom / pinch.zoom
        const from = { x: pinch.mid.x - bounds.left - bounds.width / 2, y: pinch.mid.y - bounds.top - bounds.height / 2 }
        const to = { x: mid.x - bounds.left - bounds.width / 2, y: mid.y - bounds.top - bounds.height / 2 }
        setZoom(nextZoom)
        setPan({ x: to.x - (from.x - pinch.pan.x) * ratio, y: to.y - (from.y - pinch.pan.y) * ratio })
        return
      }
    }
    if (dragOrigin) {
      setPan({ x: event.clientX - dragOrigin.x, y: event.clientY - dragOrigin.y })
      return
    }
    const gesture = measurementGestureRef.current
    if (gesture && gesture.pointerId === event.pointerId && distance(gesture.start, { x: event.clientX, y: event.clientY }) > 5) gesture.moved = true
    const point = toImagePoint(event)
    const handle = calibrationHandleRef.current
    if (handle && handle.pointerId === event.pointerId && point && calibrationDraft) {
      setCalibrationDraft({ ...calibrationDraft, [handle.key]: point })
      return
    }
    if (point && tool === 'measure' && manualStart) {
      setManualDraft(regionBetween(manualStart, point))
    } else if (point && tool === 'calibrate' && calibrationDraft && !calibrationLocked) {
      setCalibrationDraft({ ...calibrationDraft, end: point })
    }
  }

  const finishCanvasPointer = (event: PointerEvent<HTMLCanvasElement>) => {
    touchPointersRef.current.delete(event.pointerId)
    if (touchPointersRef.current.size < 2) pinchRef.current = null
    const tap = calibrationTapRef.current
    calibrationTapRef.current = null
    if (tap && tap.pointerId === event.pointerId && distance(tap.start, { x: event.clientX, y: event.clientY }) <= 8) placeCalibrationPoint(toImagePoint(event) ?? tap.point)
    setDragOrigin(null)
    calibrationHandleRef.current = null
    if (!calibration || event.button !== 0) return
    if (tool !== 'measure' || !manualStart || !manualDraft || !imageSize) return
    const gesture = measurementGestureRef.current
    measurementGestureRef.current = null
    const end = toImagePoint(event)
    const region = end ? regionBetween(manualStart, end) : manualDraft
    setManualStart(null)
    setManualDraft(null)
    if (gesture && gesture.pointerId === event.pointerId && !gesture.moved && distance(gesture.start, { x: event.clientX, y: event.clientY }) <= 5 && end) {
      void detectAtPoint(end)
      return
    }
    if (region.width < 8 || region.height < 8) {
      setStatus('Drag a larger box to measure')
      return
    }
    const objectId = `manual-${Date.now()}`
    setBoxEditor({ objectId, measurementId: null, rect: boxFromRegion(region) })
    setStatus('Adjust box dimensions and accept to add the measurement')
  }

  const saveCalibration = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!calibrationDraft) return
    const length = Number(knownLength)
    const pixels = distance(calibrationDraft.start, calibrationDraft.end)
    if (!Number.isFinite(length) || !Number.isFinite(pixels) || length <= 0 || pixels <= 0) return
    const nextCalibration = { pixelsPerUnit: pixels / length, unit: calibrationUnit }
    setCalibration(nextCalibration)
    applyDetectionAreaDefaults(nextCalibration, imageSize?.x ?? 0)
    setCalibrationDraft(null)
    setCalibrationLocked(false)
    setTool('measure')
    setStatus(`Scale set · ${calibrationUnit} per ${length}`)
  }

  const exportStem = imageName.replace(/\.[^.]+$/, '') || 'mycrometer'

  const exportCsv = (csv: string, fileName: string) => {
    void downloadCsv(csv, fileName).catch(() => setStatus('Could not save CSV. Please try exporting again.'))
  }

  const saveImageToSet = () => {
    if (!calibration || !imageSize || !imageId || !measurements.length) return
    const snapshot: MeasurementSetImage = {
      id: imageId,
      imageName,
      imageWidth: imageSize.x,
      imageHeight: imageSize.y,
      calibration,
      measurements,
    }
    setMeasurementSet((current) => current.some((image) => image.id === imageId)
      ? current.map((image) => image.id === imageId ? snapshot : image)
      : [...current, snapshot])
    setStatus(`${imageName} saved to measurement set`)
  }

  const exportRawCsv = () => {
    if (!calibration || !measurements.length) return
    exportCsv(rawMeasurementsCsv(measurements, calibration), `${exportStem}-measurements.csv`)
  }

  const exportSessionCsv = () => {
    if (!calibration || !measurements.length || !imageSize) return
    exportCsv(sessionCsv(measurements, calibration, imageName, imageSize), `${exportStem}-session.csv`)
  }

  const clearMeasurements = () => {
    if (!calibration) return
    setMeasurements([])
    setManualStart(null)
    setManualDraft(null)
    setStatus('Measurements cleared')
  }

  const openMeasurementEditor = (measurement: Measurement) => {
    if (!calibration) return
    const rect = measurement.kind === 'box'
      ? normalizeOrientedBox(measurement.rect)
      : boxFromRegion(regionBetween(measurement.start, measurement.end))
    const objectId = measurement.kind === 'box' ? measurement.objectId : `manual-${measurement.id}`
    setTool('select')
    setBoxEditor({ objectId, measurementId: measurement.id, rect })
  }

  const acceptBoxEdit = () => {
    if (!calibration || !boxEditor) return
    const existingIndex = measurements.findIndex((measurement) => measurement.id === boxEditor.measurementId)
    const name = existingIndex >= 0
      ? measurements[existingIndex].name
      : `B${measurements.filter((measurement) => measurement.kind === 'box').length + 1}`
    setMeasurements((current) => {
      const currentIndex = boxEditor.measurementId === null ? -1 : current.findIndex((measurement) => measurement.id === boxEditor.measurementId)
      if (currentIndex >= 0) {
        return current.map((measurement) => measurement.id === boxEditor.measurementId
          ? { id: measurement.id, kind: 'box', objectId: boxEditor.objectId, rect: boxEditor.rect, name: measurement.name }
          : measurement)
      }
      return [...current, { id: Date.now(), kind: 'box', objectId: boxEditor.objectId, rect: boxEditor.rect, name }]
    })
    setBoxEditor(null)
    const pixelsPerUnit = calibration?.pixelsPerUnit ?? 1
    const unit = calibration?.unit ?? 'px'
    setTool(boxEditor.measurementId === null && boxEditor.objectId.startsWith('clicked-') ? 'measure' : 'select')
    setStatus(`Box accepted · ${formatLength(boxEditor.rect.width / pixelsPerUnit)} × ${formatLength(boxEditor.rect.height / pixelsPerUnit)} ${unit}`)
  }

  const onWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    if (!imageSize) return
    event.preventDefault()
    if (!viewRef.current) return
    const nextZoom = clampZoom(zoom * (event.deltaY < 0 ? 1.12 : 0.89))
    const ratio = nextZoom / zoom
    const bounds = viewRef.current.getBoundingClientRect()
    const cursor = { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 }
    setZoom(nextZoom)
    setPan({ x: cursor.x - (cursor.x - pan.x) * ratio, y: cursor.y - (cursor.y - pan.y) * ratio })
  }

  const setFit = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  const scaleText = calibration ? `1 ${calibration.unit} = ${calibration.pixelsPerUnit.toFixed(2)} px` : t('Not calibrated')
  const boxMeasurements = measurements.filter((measurement): measurement is Extract<Measurement, { kind: 'box' }> => measurement.kind === 'box')
  const pixelsPerUnit = calibration?.pixelsPerUnit ?? 1
  const overviewLengths = boxMeasurements.map((measurement) => measurement.rect.width / pixelsPerUnit)
  const overviewWidths = boxMeasurements.map((measurement) => measurement.rect.height / pixelsPerUnit)
  const overviewQ = boxMeasurements.map((measurement) => measurement.rect.width / Math.max(1, measurement.rect.height))
  const lengthStats = summarize(overviewLengths)
  const widthStats = summarize(overviewWidths)
  const qStats = summarize(overviewQ)
  const measurementUnit = calibration?.unit ?? 'px'
  const mycologicalTitle = boxMeasurements.length
    ? `${formatMycologicalRange(lengthStats)} × ${formatMycologicalRange(widthStats)} ${measurementUnit}, Q = ${formatMycologicalNumber(qStats.min)}–${formatMycologicalNumber(qStats.max)}; N = ${boxMeasurements.length}, Me = ${formatMycologicalMedian(lengthStats.median)} × ${formatMycologicalMedian(widthStats.median)} ${measurementUnit}; Qe = ${formatMycologicalMedian(qStats.median)}`
    : t('Add box measurements to calculate the spore summary.')
  const setBoxes = measurementSetBoxes(measurementSet, setUnit)
  const setLengthStats = summarize(setBoxes.map((box) => box.length))
  const setWidthStats = summarize(setBoxes.map((box) => box.width))
  const setQStats = summarize(setBoxes.map((box) => box.q))
  const setMeasurementCount = measurementSet.reduce((total, image) => total + image.measurements.length, 0)
  const currentImageInSet = measurementSet.some((image) => image.id === imageId)

  return (
    <main className="app-shell" lang={language}>
      <header className="topbar">
        <a className="brand" href={import.meta.env.BASE_URL} aria-label={t('Mycrometer home')}>
          <span className="brand-mark" aria-hidden="true"><i /></span>
          <span>mycro<span className="brand-light">meter</span></span>
        </a>
        <div className="topbar-file" title={imageName}>{imageName || t('Untitled image')}</div>
        <div className="topbar-actions">
          <span className="offline-indicator"><i />{t('Local workspace')}</span>
            <label className="language-picker"><span>{t('Language')}</span><select aria-label={t('Language')} value={language} onChange={(event) => setLanguage(event.target.value)}>{Object.entries(locales).map(([code, languageLocale]) => <option key={code} value={code}>{languageLocale.languageName}</option>)}</select></label>
          <button className="button button-quiet" type="button" title={t('Import a session CSV; select its image too to load both at once')} onClick={() => importInputRef.current?.click()}>{t('Import session')}</button>
          <input ref={importInputRef} className="visually-hidden" type="file" accept=".csv,text/csv,image/*" multiple onChange={handleImport} />
          <button className="button button-quiet" type="button" onClick={() => fileInputRef.current?.click()}>{t(imageUrl ? 'Replace image' : 'Open image')}</button>
          {imageUrl && <button className="button button-unload" type="button" title={t('Unload image and clear its measurements')} onClick={unloadImage}><span aria-hidden="true">×</span> {t('Unload')}</button>}
          <input ref={fileInputRef} className="visually-hidden" type="file" accept="image/*" onChange={handleUpload} />
        </div>
      </header>

      <section className="workspace">
        <aside className="tool-rail" aria-label={t('Tools')}>
          <div className="rail-group">
            <button className={`tool-button ${tool === 'measure' ? 'is-active' : ''}`} type="button" title={t('Measure object')} aria-label={t('Measure object')} disabled={!calibration} onClick={() => { setTool('measure'); setCalibrationDraft(null); setManualStart(null); setManualDraft(null) }}><span className="tool-glyph box-glyph" /></button>
            <button className={`tool-button ${tool === 'calibrate' ? 'is-active' : ''}`} type="button" title={t('Calibrate scale')} aria-label={t('Calibrate scale')} onClick={() => { setTool('calibrate'); setManualStart(null); setManualDraft(null); setStatus(calibrationLocked ? 'Drag either end to adjust, then enter the distance' : 'Click two points on a known scale bar') }}><span className="tool-glyph calibrate-glyph" /></button>
            <button className={`tool-button ${tool === 'select' ? 'is-active' : ''}`} type="button" title={t('Select or edit a box')} aria-label={t('Select or edit a box')} disabled={!calibration || !measurements.length} onClick={() => setTool('select')}><span className="tool-glyph select-glyph"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.5v12l3.2-3.1 2.1 4.6 2-.9-2.1-4.5H12z" /></svg></span></button>
            <button className={`tool-button ${tool === 'pan' ? 'is-active' : ''}`} type="button" title={t('Pan image')} aria-label={t('Pan image')} onClick={() => setTool('pan')}><span className="tool-glyph pan-glyph" /></button>
          </div>
          <div className="rail-divider" />
          <div className="rail-group">
            <button className="tool-button" type="button" title={t('Undo last measurement')} aria-label={t('Undo last measurement')} disabled={!calibration || (!measurements.length && !manualStart)} onClick={() => { if (manualStart) { setManualStart(null); setManualDraft(null) } else setMeasurements((items) => items.slice(0, -1)) }}><span className="tool-glyph undo-glyph" /></button>
            <button className="tool-button" type="button" title={t('Clear measurements')} aria-label={t('Clear measurements')} disabled={!calibration || !measurements.length} onClick={clearMeasurements}><span className="tool-glyph clear-glyph" /></button>
          </div>
          <div className="rail-spacer" />
          <div className="rail-zoom">
            <button className="tool-button small-tool" type="button" title={t('Zoom in')} aria-label={t('Zoom in')} onClick={() => setZoom((value) => clampZoom(value * 1.2))}>+</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button className="tool-button small-tool" type="button" title={t('Zoom out')} aria-label={t('Zoom out')} onClick={() => setZoom((value) => clampZoom(value / 1.2))}>−</button>
            <button className="tool-button small-tool fit-button" type="button" title={t('Fit image')} aria-label={t('Fit image')} onClick={setFit}>{t('Fit')}</button>
          </div>
        </aside>

        <div className="image-column">
          <div className="canvas-toolbar">
            <div className="canvas-context">
              <span className="context-label">{t('IMAGE')}</span>
              <span className="context-value">{imageSize ? `${imageSize.x} × ${imageSize.y} px` : t('Waiting for image')}</span>
            </div>
            <div className="canvas-status"><span className={`tool-dot ${tool}`} />{translateStatus(status, locale)}</div>
            <button className="button button-small" type="button" onClick={setFit} disabled={!imageSize}>{t('Fit view')}</button>
          </div>
          <section className="spore-title-bar" aria-label={t('Mycological spore summary')}>
            <span className="eyebrow">{t('MYCOLOGICAL SUMMARY · D1–D9 PERCENTILES')}</span>
            <strong>{mycologicalTitle}</strong>
          </section>
          <div className={`canvas-wrap ${!imageSize ? 'is-empty' : ''}`} ref={viewRef}>
            {imageUrl ? (
              <canvas
                ref={canvasRef}
                aria-label={t('Image measurement canvas')}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={finishCanvasPointer}
                onPointerCancel={(event) => { touchPointersRef.current.delete(event.pointerId); pinchRef.current = null; calibrationTapRef.current = null; measurementGestureRef.current = null; calibrationHandleRef.current = null; setDragOrigin(null); setManualStart(null); setManualDraft(null) }}
                onWheel={onWheel}
                className={`measurement-canvas cursor-${tool}`}
              />
            ) : (
              <button className="empty-state" type="button" onClick={() => fileInputRef.current?.click()}>
                <span className="empty-target" aria-hidden="true"><i /></span>
                <strong>{t("Let's measure some spores")}</strong>
                <span>{pendingImport ? t('Open {imageName} to restore its measurements', { imageName: pendingImport.imageName }) : t('Open a microscope image to start measuring')}</span>
                <span className="button button-primary">{t('Choose image')}</span>
                <span className="supported-types">TIFF · PNG · JPEG · WEBP</span>
              </button>
            )}
            {calibrationDraft && calibrationLocked && distance(calibrationDraft.start, calibrationDraft.end) > 0 && (
              <form className="calibration-popover" onSubmit={saveCalibration}>
                {!calibrationEntering ? (
                  <div className="calibration-adjust">
                    <span>{t('Zoom and drag the ends to position them')}</span>
                    <button className="button button-primary" type="button" onClick={() => setCalibrationEntering(true)}>{t('Enter distance')}</button>
                  </div>
                ) : (<>
                <label htmlFor="known-length">{t('Known distance')} <button className="text-button" type="button" onClick={() => setCalibrationEntering(false)}>{t('Adjust points')}</button></label>
                <div className="calibration-fields">
                  <input id="known-length" type="number" min="0" step="any" value={knownLength} onChange={(event) => setKnownLength(event.target.value)} autoFocus={window.matchMedia('(pointer: fine)').matches} required />
                  <select value={calibrationUnit} onChange={(event) => setCalibrationUnit(event.target.value as Unit)} aria-label={t('Distance unit')}>
                    {units.map((unit) => <option key={unit}>{unit}</option>)}
                  </select>
                  <button className="button button-primary" type="submit">{t('Set scale')}</button>
                </div>
                </>)}
              </form>
            )}
          </div>
          <footer className="image-footer">
            <span>{imageSize ? `${imageSize.x} × ${imageSize.y} px` : t('No image loaded')}</span>
            <span className="footer-separator">/</span>
            <span>{calibration ? scaleText : t('Not calibrated')}</span>
            <span className="footer-spacer" />
            <span>{t(tool === 'measure' ? 'Measure object' : tool === 'calibrate' ? 'Click two points on a known length' : tool === 'select' ? 'Click a box to edit its measurement' : 'Drag to move image')}</span>
          </footer>
        </div>

        <aside className="measure-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">{t('ANALYSIS')}</span>
              <h1>{t('Measurements')}</h1>
            </div>
            <span className="count-badge">{measurements.length.toString().padStart(2, '0')}</span>
          </div>

          <section className="scale-section">
            <div className="section-title"><span>{t('Image scale')}</span><button className="text-button" type="button" onClick={() => { setTool('calibrate'); setCalibrationDraft(null); setCalibrationLocked(false); setStatus('Click two points on a known scale bar') }}>{t('Calibrate')}</button></div>
            <div className={`scale-readout ${calibration ? 'is-calibrated' : ''}`}>
              <span className="scale-symbol" aria-hidden="true">↔</span>
              <span>{scaleText}</span>
              <span className="scale-state">{t(calibration ? 'SET' : 'UNSET')}</span>
            </div>
            <p className="scale-note">{t(calibration ? 'Scale applies to all measurements in this image.' : 'Set a scale to convert pixels into real units.')}</p>
          </section>

          <section className="detection-settings" aria-labelledby="detection-settings-title">
            <div className="section-title">
              <span id="detection-settings-title">{t('Detection settings')}</span>
              <button ref={previewButtonRef} className="text-button detection-preview-open" type="button" disabled={!imageSize || detecting} onClick={() => setPreviewOpen(true)}>{t('Detection preview')}</button>
            </div>
            <label className="detection-field">
              <span>{t('Detection sensitivity')} <strong>{detectionSensitivity}/12</strong></span>
              <input type="range" min="1" max="12" value={detectionSensitivity} disabled={!calibration || detecting} onChange={(event) => setDetectionSensitivity(Number(event.target.value))} />
            </label>
            <div className="sensitivity-endpoints"><span>{t('Strong contrast only')}</span><span>{t('Include weak contrast')}</span></div>
            <label className="detection-unit-field">
              <span>{t('Size unit')}</span>
              <select value={detectionUnit} disabled={!calibration || detecting} onChange={(event) => changeDetectionUnit(event.target.value as Unit)}>
                {units.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
              </select>
            </label>
            <div className="detection-area-limits">
              <label className="detection-field">
                <span>{t('Minimum dimensions')}</span>
                <div className="detection-dimensions">
                  <input aria-label={t('Minimum width')} type="number" min="0" step="any" value={minimumWidth} disabled={!calibration || detecting} required onChange={(event) => setMinimumWidth(event.target.value)} />
                  <span aria-hidden="true">×</span>
                  <input aria-label={t('Minimum height')} type="number" min="0" step="any" value={minimumHeight} disabled={!calibration || detecting} required onChange={(event) => setMinimumHeight(event.target.value)} />
                </div>
              </label>
              <label className="detection-field">
                <span>{t('Maximum dimensions')}</span>
                <div className="detection-dimensions">
                  <input aria-label={t('Maximum width')} type="number" min="0" step="any" value={maximumWidth} disabled={!calibration || detecting} required onChange={(event) => setMaximumWidth(event.target.value)} />
                  <span aria-hidden="true">×</span>
                  <input aria-label={t('Maximum height')} type="number" min="0" step="any" value={maximumHeight} disabled={!calibration || detecting} required onChange={(event) => setMaximumHeight(event.target.value)} />
                </div>
              </label>
            </div>
            {!detectionLimitsValid && <p className="detection-settings-error" role="alert">{t('Dimensions must be positive; maximum area must be at least minimum.')}</p>}
          </section>

          <section className="results-section">
            <div className="section-title"><span>{t('Measurements')}</span><button className="text-button" type="button" onClick={exportRawCsv} disabled={!calibration || !measurements.length} title={t('Length and width values only')}>{t('Export CSV')}</button></div>
            {measurements.length ? (
              <ol className="measurement-list">
                {[...measurements].reverse().map((measurement) => {
                  const box = measurement.kind === 'box' ? normalizeOrientedBox(measurement.rect) : null
                  const q = box ? box.width / Math.max(1, box.height) : null
                  const lengthShorter = box !== null && box.width < box.height
                  return (
                    <li className={`measurement-row ${lengthShorter ? 'is-warning' : ''}`} key={measurement.id}>
                      <button className="measurement-open" type="button" disabled={!calibration} onClick={() => openMeasurementEditor(measurement)} aria-label={`${t('Edit {name}', { name: measurement.name })}${lengthShorter ? t(' (warning: length is shorter than width)') : ''}`}>
                        <span className="measurement-index">{measurement.name}</span>
                        <span className="measurement-detail">
                          <strong>{measurement.kind === 'distance'
                            ? calibration ? formatLength(measurement.pixels / calibration.pixelsPerUnit) : measurement.pixels.toFixed(1)
                            : calibration ? `${formatLength(measurement.rect.width / calibration.pixelsPerUnit)} × ${formatLength(measurement.rect.height / calibration.pixelsPerUnit)}` : `${measurement.rect.width.toFixed(0)} × ${measurement.rect.height.toFixed(0)}`}</strong>
                          <small>{measurement.kind === 'distance'
                            ? `${calibration?.unit ?? 'px'} · ${measurement.pixels.toFixed(1)} px`
                            : `L × W ${calibration?.unit ?? 'px'} · ${measurement.rect.width.toFixed(0)} × ${measurement.rect.height.toFixed(0)} px · Q ${q?.toFixed(2)} · ${measurement.rect.angle.toFixed(1)}°`}</small>
                        </span>
                        {lengthShorter && <span className="measurement-warning" title={t('Q < 1: length is shorter than width')} aria-hidden="true">⚠</span>}
                      </button>
                      {measurement.kind === 'box' && <button className="swap-button" type="button" disabled={!calibration} title={t('Swap length and width')} aria-label={t('Swap length and width for {name}', { name: measurement.name })} onClick={() => setMeasurements((items) => items.map((item) => item.id === measurement.id && item.kind === 'box' ? { ...item, rect: swapBoxAxes(item.rect) } : item))}><span aria-hidden="true">↕</span></button>}
                      <button className="remove-button" type="button" disabled={!calibration} title={t('Remove {name}', { name: measurement.name })} aria-label={t('Remove {name}', { name: measurement.name })} onClick={() => setMeasurements((items) => items.filter((item) => item.id !== measurement.id))}>×</button>
                    </li>
                  )
                })}
              </ol>
            ) : (
              <div className="no-results"><span className="no-results-mark" aria-hidden="true">＋</span><span>{t('No measurements yet')}</span></div>
            )}
          </section>

          <section className="overview-section" aria-labelledby="overview-title">
            <div className="section-title"><span id="overview-title">{t('Spore overview')}</span><span className="overview-n">N = {boxMeasurements.length}</span></div>
            <div className="overview-table" role="table" aria-label={t('Spore size and Q summary')}>
              <div className="overview-row overview-header" role="row"><span role="columnheader">{t('Metric')}</span><span role="columnheader">{t('Mean ± SD')}</span><span role="columnheader">D1–D9</span></div>
              <div className="overview-row" role="row"><span role="rowheader">{t('Length')}</span><span role="cell">{formatSummary(lengthStats, measurementUnit)}</span><span role="cell">{formatDeciles(lengthStats, measurementUnit)}</span></div>
              <div className="overview-row" role="row"><span role="rowheader">{t('Width')}</span><span role="cell">{formatSummary(widthStats, measurementUnit)}</span><span role="cell">{formatDeciles(widthStats, measurementUnit)}</span></div>
              <div className="overview-row" role="row"><span role="rowheader">Q</span><span role="cell">{formatSummary(qStats, '')}</span><span role="cell">{formatDeciles(qStats, '')}</span></div>
            </div>
            <p className="overview-note">{t('Length and width follow each measurement (use the swap control to exchange them); Q = length ÷ width. SD uses n−1; D1–D9 are interpolated 10th–90th percentiles, with observed extremes in parentheses.')}</p>
          </section>

          <section className="overview-section measurement-set-section" aria-labelledby="measurement-set-title">
            <div className="section-title"><span id="measurement-set-title">{t('Measurement set')}</span><span className="overview-n">{t('{count} images · N = {total}', { count: measurementSet.length, total: setBoxes.length })}</span></div>
            <button className="button set-save-button" type="button" onClick={saveImageToSet} disabled={!calibration || !measurements.length}>
              <span aria-hidden="true">{currentImageInSet ? '↻' : '+'}</span> {t(currentImageInSet ? 'Update image in set' : 'Add image to set')}
            </button>
            {measurementSet.length > 0 && <>
              <ul className="set-image-list" aria-label={t('Images in measurement set')}>
                {measurementSet.map((image) => (
                  <li key={image.id}>
                    <span className="set-image-detail"><strong title={image.imageName}>{image.imageName}</strong><small>{t('{count} measurements · {pixelsPerUnit} px/{unit}{currentImage}', { count: image.measurements.length, pixelsPerUnit: image.calibration.pixelsPerUnit.toFixed(2), unit: image.calibration.unit, currentImage: image.id === imageId ? t('current image') : '' })}</small></span>
                    <button className="remove-button" type="button" title={t('Remove {imageName} from set', { imageName: image.imageName })} aria-label={t('Remove {imageName} from set', { imageName: image.imageName })} onClick={() => setMeasurementSet((current) => current.filter((entry) => entry.id !== image.id))}>×</button>
                  </li>
                ))}
              </ul>
              <label className="detection-field"><span>{t('Set unit')}</span><select value={setUnit} onChange={(event) => setSetUnit(event.target.value as Unit)}>{units.map((unit) => <option key={unit}>{unit}</option>)}</select></label>
              <div className="overview-table" role="table" aria-label={t('Measurement set size and Q summary')}>
                <div className="overview-row overview-header" role="row"><span role="columnheader">{t('Metric')}</span><span role="columnheader">{t('Mean ± SD')}</span><span role="columnheader">D1–D9</span></div>
                <div className="overview-row" role="row"><span role="rowheader">{t('Length')}</span><span role="cell">{formatSummary(setLengthStats, setUnit)}</span><span role="cell">{formatDeciles(setLengthStats, setUnit)}</span></div>
                <div className="overview-row" role="row"><span role="rowheader">{t('Width')}</span><span role="cell">{formatSummary(setWidthStats, setUnit)}</span><span role="cell">{formatDeciles(setWidthStats, setUnit)}</span></div>
                <div className="overview-row" role="row"><span role="rowheader">Q</span><span role="cell">{formatSummary(setQStats, '')}</span><span role="cell">{formatDeciles(setQStats, '')}</span></div>
              </div>
              {setBoxes.length > 0 && <p className="set-summary">{formatMycologicalRange(setLengthStats)} × {formatMycologicalRange(setWidthStats)} {setUnit}, Q = {formatMycologicalNumber(setQStats.min)}–{formatMycologicalNumber(setQStats.max)}; N = {setBoxes.length}, Me = {formatMycologicalMedian(setLengthStats.median)} × {formatMycologicalMedian(setWidthStats.median)} {setUnit}; Qe = {formatMycologicalMedian(setQStats.median)}</p>}
              <div className="set-actions">
                <button className="text-button" type="button" title={t('Combined measurement values with source image names; not a session file')} onClick={() => exportCsv(measurementSetCsv(measurementSet, setUnit), 'mycrometer-set.csv')}>{t('Export set CSV')}</button>
                <button className="text-button" type="button" onClick={() => setMeasurementSet([])}>{t('Clear set')}</button>
              </div>
              <div className="summary-line set-total"><span>{t('Set measurements')}</span><strong>{setMeasurementCount}</strong></div>
            </>}
          </section>

          <div className="panel-bottom">
            <div className="summary-line"><span>{t('Total measurements')}</span><strong>{measurements.length}</strong></div>
            <button className="button button-export" type="button" onClick={exportSessionCsv} disabled={!calibration || !measurements.length} title={t('CSV with calibration and box geometry for re-import')}><span aria-hidden="true">↓</span> {t('Export session')}</button>
            <p className="privacy-note"><span aria-hidden="true">◈</span> {t('Images stay on this device')}</p>
          </div>
        </aside>
      </section>
      <div className="detection-notice" role="status" aria-live="polite" aria-atomic="true">
        {detectionNotice && detectionNotice.imageUrl === imageUrl && <>
          <strong>{t('No object found')}</strong>
          <span>{t('Drag on the image to draw a manual box.')}</span>
        </>}
      </div>
      {previewOpen && imageRef.current && imageSize && (
        <DetectionPreviewDialog
          key={imageUrl}
          image={imageRef.current}
          initialPoint={lastDetectionPointRef.current}
          sensitivity={detectionSensitivity}
          noiseFilter={noiseFilter}
          onNoiseFilterChange={setNoiseFilter}
          recoverNearby={recoverNearby}
          onRecoverNearbyChange={setRecoverNearby}
          onSensitivityChange={setDetectionSensitivity}
          onPointChange={(point) => { lastDetectionPointRef.current = point }}
          translate={t}
          onClose={() => {
            setPreviewOpen(false)
            requestAnimationFrame(() => previewButtonRef.current?.focus())
          }}
        />
      )}
      {boxEditor && imageRef.current && imageSize && (
        <BoxEditorDialog
          image={imageRef.current}
          imageSize={imageSize}
          editor={boxEditor}
          unit={calibration?.unit ?? 'px'}
          pixelsPerUnit={calibration?.pixelsPerUnit ?? 1}
          onChange={setBoxEditor}
          translate={t}
          onAccept={acceptBoxEdit}
          onClose={() => {
            setBoxEditor(null)
            setStatus(boxEditor.measurementId === null ? 'Box discarded' : 'Box changes discarded')
          }}
        />
      )}
    </main>
  )
}

type DetectionPreviewDialogProps = {
  image: HTMLImageElement
  initialPoint: Point | null
  sensitivity: number
  noiseFilter: NoiseFilter
  onNoiseFilterChange: (value: NoiseFilter) => void
  recoverNearby: boolean
  onRecoverNearbyChange: (value: boolean) => void
  onSensitivityChange: (value: number) => void
  onPointChange: (point: Point) => void
  translate: (text: string) => string
  onClose: () => void
}

function DetectionPreviewDialog({ image, initialPoint, sensitivity, noiseFilter, onNoiseFilterChange, recoverNearby, onRecoverNearbyChange, onSensitivityChange, onPointChange, translate: t, onClose }: DetectionPreviewDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const overviewRef = useRef<HTMLImageElement>(null)
  const overviewViewportRef = useRef<HTMLDivElement>(null)
  const overviewZoomRef = useRef(1)
  const overviewPointersRef = useRef(new Map<number, Point>())
  const overviewDragRef = useRef<{ start: Point; scroll: Point; moved: boolean } | null>(null)
  const overviewPinchRef = useRef<{ distance: number; zoom: number; source: Point } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [overviewZoom, setOverviewZoom] = useState(1)
  const [overviewSize, setOverviewSize] = useState({ width: 1, height: 1 })
  const [point, setPoint] = useState<Point>(initialPoint ?? { x: image.naturalWidth / 2, y: image.naturalHeight / 2 })
  const [mode, setMode] = useState<keyof DetectionPreview>('dark')
  const [preview, setPreview] = useState<DetectionPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const modes = ['original', 'dark', 'bright'] as const
  const modeLabels = { original: 'Original', dark: 'Dark objects', bright: 'Light objects' }
  const radius = Math.min(128, Math.max(image.naturalWidth, image.naturalHeight))
  const cropLeft = Math.max(0, Math.floor(point.x - radius))
  const cropTop = Math.max(0, Math.floor(point.y - radius))
  const cropRight = Math.min(image.naturalWidth, Math.ceil(point.x + radius))
  const cropBottom = Math.min(image.naturalHeight, Math.ceil(point.y + radius))
  const overviewScale = Math.min(overviewSize.width / image.naturalWidth, overviewSize.height / image.naturalHeight) * overviewZoom
  const overviewWidth = image.naturalWidth * overviewScale
  const overviewHeight = image.naturalHeight * overviewScale

  const zoomOverview = (value: number, anchor?: Point, source?: Point) => {
    const viewport = overviewViewportRef.current
    const bounds = overviewRef.current?.getBoundingClientRect()
    if (!viewport || !bounds?.width || !bounds.height) return
    const frame = viewport.getBoundingClientRect()
    const focalPoint = anchor ?? { x: frame.left + viewport.clientLeft + viewport.clientWidth / 2, y: frame.top + viewport.clientTop + viewport.clientHeight / 2 }
    const sourcePoint = source ?? { x: clamp((focalPoint.x - bounds.left) / bounds.width, 0, 1), y: clamp((focalPoint.y - bounds.top) / bounds.height, 0, 1) }
    const nextZoom = clamp(value, 1, 16)
    overviewZoomRef.current = nextZoom
    setOverviewZoom(nextZoom)
    requestAnimationFrame(() => {
      if (!viewport.isConnected) return
      const scale = Math.min(viewport.clientWidth / image.naturalWidth, viewport.clientHeight / image.naturalHeight) * nextZoom
      const width = image.naturalWidth * scale
      const height = image.naturalHeight * scale
      viewport.scrollLeft = Math.max(0, (viewport.clientWidth - width) / 2) + sourcePoint.x * width - (focalPoint.x - frame.left - viewport.clientLeft)
      viewport.scrollTop = Math.max(0, (viewport.clientHeight - height) / 2) + sourcePoint.y * height - (focalPoint.y - frame.top - viewport.clientTop)
    })
  }

  useEffect(() => {
    const viewport = overviewViewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(() => setOverviewSize({ width: viewport.clientWidth, height: viewport.clientHeight }))
    observer.observe(viewport)
    const handleWheel = (event: globalThis.WheelEvent) => {
      if (!event.deltaY) return
      event.preventDefault()
      zoomOverview(overviewZoomRef.current * (event.deltaY < 0 ? 1.2 : 1 / 1.2), { x: event.clientX, y: event.clientY })
    }
    viewport.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      observer.disconnect()
      viewport.removeEventListener('wheel', handleWheel)
    }
  }, [image])

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      dialog?.close()
      document.body.style.overflow = previousOverflow
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)
    const timeout = window.setTimeout(() => {
      void createDetectionPreview(image, point, sensitivity, noiseFilter).then((result) => {
        if (!cancelled) {
          setPreview(result)
          setLoading(false)
        }
      }).catch(() => {
        if (!cancelled) {
          setFailed(true)
          setLoading(false)
        }
      })
    }, 120)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [image, point, sensitivity, noiseFilter, retry])

  useEffect(() => {
    const canvas = canvasRef.current
    const source = preview?.[mode]
    if (!canvas || !source) return
    canvas.width = source.width
    canvas.height = source.height
    canvas.getContext('2d')?.drawImage(source, 0, 0)
  }, [preview, mode])

  const selectPoint = (next: Point) => {
    const bounded = { x: clamp(next.x, 0, image.naturalWidth), y: clamp(next.y, 0, image.naturalHeight) }
    setPoint(bounded)
    onPointChange(bounded)
  }

  const startOverviewPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const viewport = event.currentTarget
    overviewPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    viewport.setPointerCapture(event.pointerId)
    if (overviewPointersRef.current.size === 1) {
      overviewDragRef.current = { start: { x: event.clientX, y: event.clientY }, scroll: { x: viewport.scrollLeft, y: viewport.scrollTop }, moved: false }
    } else if (overviewPointersRef.current.size === 2) {
      const [first, second] = [...overviewPointersRef.current.values()]
      const bounds = overviewRef.current!.getBoundingClientRect()
      overviewPinchRef.current = {
        distance: Math.max(1, distance(first, second)),
        zoom: overviewZoomRef.current,
        source: { x: ((first.x + second.x) / 2 - bounds.left) / bounds.width, y: ((first.y + second.y) / 2 - bounds.top) / bounds.height },
      }
      if (overviewDragRef.current) overviewDragRef.current.moved = true
    }
  }

  const moveOverviewPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (!overviewPointersRef.current.has(event.pointerId)) return
    overviewPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const pinch = overviewPinchRef.current
    if (pinch && overviewPointersRef.current.size >= 2) {
      const [first, second] = [...overviewPointersRef.current.values()]
      zoomOverview(pinch.zoom * distance(first, second) / pinch.distance, { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }, pinch.source)
      return
    }
    const drag = overviewDragRef.current
    if (!drag) return
    const deltaX = event.clientX - drag.start.x
    const deltaY = event.clientY - drag.start.y
    if (Math.hypot(deltaX, deltaY) > 5) drag.moved = true
    if (drag.moved) {
      event.currentTarget.scrollLeft = drag.scroll.x - deltaX
      event.currentTarget.scrollTop = drag.scroll.y - deltaY
    }
  }

  const finishOverviewPointer = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (!overviewPointersRef.current.has(event.pointerId)) return
    const drag = overviewDragRef.current
    overviewPointersRef.current.delete(event.pointerId)
    if (!cancelled && drag && !drag.moved && overviewPointersRef.current.size === 0) {
      const bounds = overviewRef.current!.getBoundingClientRect()
      if (event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
        selectPoint({ x: (event.clientX - bounds.left) / bounds.width * image.naturalWidth, y: (event.clientY - bounds.top) / bounds.height * image.naturalHeight })
      }
    }
    if (overviewPointersRef.current.size < 2) overviewPinchRef.current = null
    const remaining = [...overviewPointersRef.current.values()][0]
    overviewDragRef.current = remaining ? { start: remaining, scroll: { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop }, moved: true } : null
  }

  return (
    <dialog ref={dialogRef} className="detection-preview-dialog" aria-labelledby="detection-preview-title" onCancel={(event) => { event.preventDefault(); onClose() }} onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }} onClick={(event) => {
      if (event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
    }}>
      <header className="box-editor-header">
        <h2 id="detection-preview-title">{t('Detection preview')}</h2>
        <button className="box-editor-close" type="button" aria-label={t('Close preview')} title={t('Close preview')} onClick={onClose} autoFocus>×</button>
      </header>
      <div className="detection-preview-body">
        <div className="section-title detection-preview-overview-heading">
          <span>{t('Sample area')}</span>
          <div className="detection-preview-zoom" role="group" aria-label={t('Zoom')}>
            <button className="tool-button" type="button" title={t('Zoom out')} aria-label={t('Zoom out')} disabled={overviewZoom <= 1} onClick={() => zoomOverview(overviewZoomRef.current / 1.5)}>−</button>
            <span>{Math.round(overviewZoom * 100)}%</span>
            <button className="tool-button" type="button" title={t('Zoom in')} aria-label={t('Zoom in')} disabled={overviewZoom >= 16} onClick={() => zoomOverview(overviewZoomRef.current * 1.5)}>+</button>
            <button className="tool-button fit-button" type="button" title={t('Fit image')} aria-label={t('Fit image')} onClick={() => zoomOverview(1)}>{t('Fit')}</button>
          </div>
        </div>
        <div ref={overviewViewportRef} className="detection-preview-overview-viewport" onPointerDown={startOverviewPointer} onPointerMove={moveOverviewPointer} onPointerUp={(event) => finishOverviewPointer(event)} onPointerCancel={(event) => finishOverviewPointer(event, true)}>
          <div className="detection-preview-overview-content" style={{ width: Math.max(overviewSize.width, overviewWidth), height: Math.max(overviewSize.height, overviewHeight) }}>
            <button className="detection-preview-overview" type="button" aria-label={t('Sample area')} style={{ width: overviewWidth, height: overviewHeight, left: Math.max(0, (overviewSize.width - overviewWidth) / 2), top: Math.max(0, (overviewSize.height - overviewHeight) / 2) }} onKeyDown={(event) => {
              const directions: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } }
              const direction = directions[event.key]
              if (!direction) return
              event.preventDefault()
              selectPoint({ x: point.x + direction.x * Math.max(1, image.naturalWidth / (50 * overviewZoom)), y: point.y + direction.y * Math.max(1, image.naturalHeight / (50 * overviewZoom)) })
            }}>
              <img ref={overviewRef} src={image.src} alt="" draggable={false} />
              <span className="detection-preview-region" style={{ left: `${cropLeft / image.naturalWidth * 100}%`, top: `${cropTop / image.naturalHeight * 100}%`, width: `${(cropRight - cropLeft) / image.naturalWidth * 100}%`, height: `${(cropBottom - cropTop) / image.naturalHeight * 100}%` }} />
            </button>
          </div>
        </div>
        <label className="detection-preview-filter">
          <span>{t('Noise reduction')}</span>
          <select value={noiseFilter} onChange={(event) => onNoiseFilterChange(event.target.value as NoiseFilter)}>
            <option value="gaussian">{t('Current smoothing')}</option>
            <option value="median">{t('Median')}</option>
            <option value="bilateral">{t('Edge-preserving')}</option>
          </select>
        </label>
        <label className="detection-preview-recovery">
          <input type="checkbox" checked={recoverNearby} onChange={(event) => onRecoverNearbyChange(event.target.checked)} />
          <span>{t('Recover nearby objects')}</span>
        </label>
        <div className="detection-preview-modes" role="group" aria-label={t('Preview mode')}>
          {modes.map((value) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>{t(modeLabels[value])}</button>)}
        </div>
        <div className="detection-preview-image" aria-busy={loading}>
          <canvas ref={canvasRef} aria-label={t(modeLabels[mode])} style={{ visibility: loading || failed ? 'hidden' : 'visible' }} />
          <div className="detection-preview-status" role="status">
            {loading ? t('Updating preview...') : failed ? <><span>{t('Preview unavailable')}</span><button className="button button-small" type="button" onClick={() => setRetry((value) => value + 1)}>{t('Retry')}</button></> : null}
          </div>
        </div>
      </div>
      <footer className="detection-preview-controls">
        <label className="detection-field">
          <span>{t('Detection sensitivity')} <strong>{sensitivity}/12</strong></span>
          <input type="range" min="1" max="12" value={sensitivity} onChange={(event) => onSensitivityChange(Number(event.target.value))} />
        </label>
        <div className="sensitivity-endpoints"><span>{t('Strong contrast only')}</span><span>{t('Include weak contrast')}</span></div>
      </footer>
    </dialog>
  )
}

type BoxEditorDialogProps = {
  image: HTMLImageElement
  imageSize: Point
  editor: BoxEditorState
  unit: Unit | 'px'
  pixelsPerUnit: number
  onChange: (editor: BoxEditorState) => void
  translate: (text: string) => string
  onAccept: () => void
  onClose: () => void
}

function BoxEditorDialog({ image, imageSize, editor, unit, pixelsPerUnit, onChange, translate: t, onAccept, onClose }: BoxEditorDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  const initialRectRef = useRef(normalizeOrientedBox(editor.rect))
  const transformRef = useRef<EditorTransform | null>(null)
  const dragRef = useRef<EditorDrag | null>(null)
  const touchPointersRef = useRef(new Map<number, Point>())
  const pinchRef = useRef<{ distance: number; mid: Point; scale: number; offsetX: number; offsetY: number } | null>(null)
  const panRef = useRef<{ pointerId: number; point: Point } | null>(null)
  const initialScaleRef = useRef(1)
  const [viewVersion, setViewVersion] = useState(0)
  const canvasWidth = 960
  const canvasHeight = 560

  onCloseRef.current = onClose

  useEffect(() => {
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    canvas.width = canvasWidth
    canvas.height = canvasHeight
    context.fillStyle = '#17221e'
    context.fillRect(0, 0, canvasWidth, canvasHeight)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'

    let transform = transformRef.current
    if (!transform) {
      const bounds = boxBounds(initialRectRef.current)
      const paddingX = Math.max(36, bounds.width * 0.65)
      const paddingY = Math.max(36, bounds.height * 0.65)
      const cropWidth = Math.min(imageSize.x, Math.max(1, bounds.width + paddingX * 2))
      const cropHeight = Math.min(imageSize.y, Math.max(1, bounds.height + paddingY * 2))
      const cropX = clamp(bounds.x + bounds.width / 2 - cropWidth / 2, 0, imageSize.x - cropWidth)
      const cropY = clamp(bounds.y + bounds.height / 2 - cropHeight / 2, 0, imageSize.y - cropHeight)
      const scale = Math.min((canvasWidth - 64) / cropWidth, (canvasHeight - 64) / cropHeight)
      const offsetX = (canvasWidth - cropWidth * scale) / 2
      const offsetY = (canvasHeight - cropHeight * scale) / 2
      transform = { cropX, cropY, cropWidth, cropHeight, scale, offsetX, offsetY }
      transformRef.current = transform
      initialScaleRef.current = scale
    }
    const { cropX, cropY, scale, offsetX, offsetY } = transform
    const visibleLeft = clamp(cropX - offsetX / scale, 0, imageSize.x)
    const visibleRight = clamp(cropX + (canvasWidth - offsetX) / scale, 0, imageSize.x)
    const visibleTop = clamp(cropY - offsetY / scale, 0, imageSize.y)
    const visibleBottom = clamp(cropY + (canvasHeight - offsetY) / scale, 0, imageSize.y)
    if (visibleRight > visibleLeft && visibleBottom > visibleTop) {
      context.drawImage(
        image,
        visibleLeft, visibleTop, visibleRight - visibleLeft, visibleBottom - visibleTop,
        offsetX + (visibleLeft - cropX) * scale, offsetY + (visibleTop - cropY) * scale,
        (visibleRight - visibleLeft) * scale, (visibleBottom - visibleTop) * scale,
      )
    }

    const toCanvas = (point: Point) => ({
      x: offsetX + (point.x - cropX) * scale,
      y: offsetY + (point.y - cropY) * scale,
    })
    const corners = boxCorners(editor.rect).map(toCanvas)
    const north = toCanvas(boxHandles(editor.rect, 0).find((handle) => handle.handle === 'n')!)
    const rotationHandle = toCanvas(boxHandles(editor.rect, 28 / scale).find((handle) => handle.handle === 'rotate')!)
    context.strokeStyle = '#ef6248'
    context.lineWidth = 2
    context.beginPath()
    context.moveTo(corners[0].x, corners[0].y)
    corners.slice(1).forEach((point) => context.lineTo(point.x, point.y))
    context.closePath()
    context.stroke()
    context.beginPath()
    context.moveTo(north.x, north.y)
    context.lineTo(rotationHandle.x, rotationHandle.y)
    context.stroke()
    boxHandles(editor.rect, 28 / scale).forEach(({ handle, ...sourceHandle }) => {
      const { x, y } = toCanvas(sourceHandle)
      if (handle === 'rotate') {
        context.beginPath()
        context.fillStyle = '#d7f06a'
        context.strokeStyle = '#536a35'
        context.lineWidth = 1.5
        context.arc(x, y, 8, 0, Math.PI * 2)
        context.fill()
        context.stroke()
        return
      }
      context.fillStyle = '#fffdf1'
      context.fillRect(x - 7, y - 7, 14, 14)
      context.strokeStyle = '#b43c2b'
      context.lineWidth = 1.5
      context.strokeRect(x - 7, y - 7, 14, 14)
    })
  }, [canvasHeight, canvasWidth, editor, image, imageSize, viewVersion])

  const canvasPoint = (event: PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: (event.clientX - bounds.left) * canvasWidth / bounds.width,
      y: (event.clientY - bounds.top) * canvasHeight / bounds.height,
    }
  }

  // Keeps the source point under `from` at `to` after changing scale.
  const setView = (base: { scale: number; offsetX: number; offsetY: number }, nextScale: number, from: Point, to: Point) => {
    const transform = transformRef.current
    if (!transform) return
    const sourceX = (from.x - base.offsetX) / base.scale + transform.cropX
    const sourceY = (from.y - base.offsetY) / base.scale + transform.cropY
    transform.scale = nextScale
    transform.offsetX = to.x - (sourceX - transform.cropX) * nextScale
    transform.offsetY = to.y - (sourceY - transform.cropY) * nextScale
    setViewVersion((version) => version + 1)
  }

  const scaleLimits = () => {
    const initial = initialScaleRef.current
    return { min: initial * 0.5, max: initial * 40 }
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handleWheel = (event: globalThis.WheelEvent) => {
      const transform = transformRef.current
      if (!transform) return
      event.preventDefault()
      const bounds = canvas.getBoundingClientRect()
      const point = { x: (event.clientX - bounds.left) * canvasWidth / bounds.width, y: (event.clientY - bounds.top) * canvasHeight / bounds.height }
      const limits = scaleLimits()
      const nextScale = clamp(transform.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), limits.min, limits.max)
      setView(transform, nextScale, point, point)
    }
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sourcePoint = (event: PointerEvent<HTMLCanvasElement>) => {
    const transform = transformRef.current
    if (!transform) return null
    const point = canvasPoint(event)
    return {
      x: clamp((point.x - transform.offsetX) / transform.scale + transform.cropX, 0, imageSize.x),
      y: clamp((point.y - transform.offsetY) / transform.scale + transform.cropY, 0, imageSize.y),
    }
  }

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const transform = transformRef.current
    if (!transform) return
    const point = canvasPoint(event)
    if (event.pointerType === 'touch') {
      touchPointersRef.current.set(event.pointerId, point)
      if (touchPointersRef.current.size >= 2) {
        const [a, b] = [...touchPointersRef.current.values()]
        pinchRef.current = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, scale: transform.scale, offsetX: transform.offsetX, offsetY: transform.offsetY }
        dragRef.current = null
        panRef.current = null
        return
      }
    }
    const handles = boxHandles(editor.rect, 28 / transform.scale).map(({ handle, x, y }) => ({
      handle,
      x: transform.offsetX + (x - transform.cropX) * transform.scale,
      y: transform.offsetY + (y - transform.cropY) * transform.scale,
    }))
    const nearest = handles
      .map((handle) => ({ ...handle, distance: Math.hypot(handle.x - point.x, handle.y - point.y) }))
      .sort((a, b) => a.distance - b.distance)[0]
    if (!nearest || nearest.distance > 26) {
      panRef.current = { pointerId: event.pointerId, point }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    const start = sourcePoint(event)
    if (!start) return
    const offset = nearest.handle === 'rotate'
      ? { x: 0, y: 0 }
      : { x: (nearest.x - point.x) / transform.scale, y: (nearest.y - point.y) / transform.scale }
    dragRef.current = { handle: nearest.handle, rect: editor.rect, start, offset }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const transform = transformRef.current
    if (event.pointerType === 'touch' && touchPointersRef.current.has(event.pointerId)) {
      touchPointersRef.current.set(event.pointerId, canvasPoint(event))
      const pinch = pinchRef.current
      if (pinch && touchPointersRef.current.size >= 2) {
        const [a, b] = [...touchPointersRef.current.values()]
        const limits = scaleLimits()
        const nextScale = clamp(pinch.scale * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance, limits.min, limits.max)
        setView(pinch, nextScale, pinch.mid, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
        return
      }
    }
    const pan = panRef.current
    if (pan && transform && pan.pointerId === event.pointerId) {
      const point = canvasPoint(event)
      transform.offsetX += point.x - pan.point.x
      transform.offsetY += point.y - pan.point.y
      pan.point = point
      setViewVersion((version) => version + 1)
      return
    }
    const drag = dragRef.current
    const point = sourcePoint(event)
    if (!drag || !point) return
    const adjustedPoint = { x: point.x + drag.offset.x, y: point.y + drag.offset.y }
    const nextRect = drag.handle === 'rotate'
      ? rotateOrientedBox(drag.rect, drag.start, point)
      : resizeOrientedBox(drag.rect, drag.handle, adjustedPoint)
    onChange({ ...editor, rect: constrainBoxToImage(nextRect, imageSize) })
  }

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    touchPointersRef.current.delete(event.pointerId)
    if (touchPointersRef.current.size < 2) pinchRef.current = null
    dragRef.current = null
    panRef.current = null
  }

  return (
    <div className="box-editor-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="box-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="box-editor-title">
        <header className="box-editor-header">
          <div>
            <span className="eyebrow">{t('OBJECT BOX')} · {editor.objectId}</span>
            <h2 id="box-editor-title">{t('Refine oriented box')}</h2>
          </div>
          <button ref={closeButtonRef} className="box-editor-close" type="button" aria-label={t('Cancel box edit')} onClick={onClose}>×</button>
        </header>
        {editor.nearby && <div className="nearby-object-notice" role="status">{t('Nearby object selected')}</div>}
        <canvas
          ref={canvasRef}
          className="box-editor-canvas"
          aria-label={t('Zoomed image crop with draggable edge, corner, and rotation handles')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        <footer className="box-editor-footer">
          <span className="box-editor-dimensions">{formatLength(editor.rect.width / pixelsPerUnit)} × {formatLength(editor.rect.height / pixelsPerUnit)} {unit} · {editor.rect.angle.toFixed(1)}°</span>
          <div className="box-editor-actions">
            <button className="button box-editor-cancel" type="button" onClick={onClose}>{t('Cancel')}</button>
            <button className="button button-primary" type="button" onClick={onAccept}>{t('Accept dimensions')}</button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function formatLength(length: number) {
  if (length >= 100) return length.toFixed(1)
  if (length >= 10) return length.toFixed(2)
  return length.toFixed(3)
}

export default App
