import { longAxisFirst, normalizeOrientedBox, type OrientedBox } from './boxGeometry'

export type Point = { x: number; y: number }
export type Measurement =
  | { id: number; kind: 'distance'; start: Point; end: Point; pixels: number; name: string }
  | { id: number; kind: 'box'; objectId: string; rect: OrientedBox; name: string }

export const units = ['µm', 'mm', 'nm'] as const
export const MAX_IMAGE_RECORD_CSV_BYTES = 10 * 1024 * 1024
export const MAX_IMAGE_RECORD_MEASUREMENTS = 10_000
export const MAX_IMAGE_RECORD_IMAGE_PIXELS = 40_000_000
export type Unit = (typeof units)[number]
export type Calibration = { pixelsPerUnit: number; unit: Unit }

export type ImageMeasurementData = {
  imageName: string
  imageWidth: number
  imageHeight: number
  calibration: Calibration | null
  measurements: Measurement[]
}

export type MeasurementSetImage = ImageMeasurementData & { id: string; calibration: Calibration }

export function detectionsToMeasurements(detections: readonly (OrientedBox & { id: string })[], existing: readonly Measurement[] = [], firstId = Date.now()): Measurement[] {
  if (existing.length + detections.length > MAX_IMAGE_RECORD_MEASUREMENTS) throw new Error('Measurement limit reached')
  const baseId = existing.reduce((maximum, measurement) => Math.max(maximum, measurement.id + 1), firstId)
  const firstBoxNumber = existing.reduce((maximum, measurement) => {
    const number = measurement.kind === 'box' ? measurement.name.match(/^B(\d+)$/) : null
    return Math.max(maximum, number ? Number(number[1]) + 1 : 1)
  }, 1)
  return detections.map((detection, index) => ({
    id: baseId + index,
    kind: 'box',
    objectId: `auto-${baseId}-${index}-${detection.id}`,
    rect: longAxisFirst(detection),
    name: `B${firstBoxNumber + index}`,
  }))
}

const micrometresPerUnit: Record<Unit, number> = { 'µm': 1, mm: 1000, nm: 0.001 }

export function validateImageMeasurementData(value: unknown): asserts value is ImageMeasurementData {
  if (!value || typeof value !== 'object') throw new Error('Invalid image measurement data')
  const metadata = value as ImageMeasurementData
  const positive = (number: unknown) => typeof number === 'number' && Number.isFinite(number) && number > 0
  const point = (value: unknown) => {
    if (!value || typeof value !== 'object') return false
    const coordinate = value as Point
    return Number.isFinite(coordinate.x) && Number.isFinite(coordinate.y) && coordinate.x >= 0 && coordinate.y >= 0 &&
      coordinate.x <= metadata.imageWidth && coordinate.y <= metadata.imageHeight
  }
  if (typeof metadata.imageName !== 'string' || metadata.imageName.length > 1024 ||
    !Number.isInteger(metadata.imageWidth) || !positive(metadata.imageWidth) ||
    !Number.isInteger(metadata.imageHeight) || !positive(metadata.imageHeight) ||
    metadata.imageWidth * metadata.imageHeight > MAX_IMAGE_RECORD_IMAGE_PIXELS ||
    !Array.isArray(metadata.measurements) || metadata.measurements.length > MAX_IMAGE_RECORD_MEASUREMENTS ||
    (metadata.calibration !== null && (!metadata.calibration || !positive(metadata.calibration.pixelsPerUnit) || !units.includes(metadata.calibration.unit)))) {
    throw new Error('Invalid image dimensions, calibration, or measurements')
  }
  const ids = new Set<number>()
  for (const measurement of metadata.measurements) {
    if (!measurement || !Number.isSafeInteger(measurement.id) || ids.has(measurement.id) ||
      typeof measurement.name !== 'string' || measurement.name.length > 1024) {
      throw new Error('Invalid measurement identity')
    }
    ids.add(measurement.id)
    if (measurement.kind === 'distance') {
      if (!point(measurement.start) || !point(measurement.end) || !positive(measurement.pixels) ||
        Math.abs(Math.hypot(measurement.end.x - measurement.start.x, measurement.end.y - measurement.start.y) - measurement.pixels) > 0.0001) {
        throw new Error('Invalid distance geometry')
      }
    } else if (measurement.kind === 'box') {
      const box = measurement.rect
      if (!box || typeof measurement.objectId !== 'string' || measurement.objectId.length > 1024 || !point({ x: box.centerX, y: box.centerY }) ||
        !positive(box.width) || !positive(box.height) || !Number.isFinite(box.angle) ||
        box.width > Math.hypot(metadata.imageWidth, metadata.imageHeight) || box.height > Math.hypot(metadata.imageWidth, metadata.imageHeight)) {
        throw new Error('Invalid box geometry')
      }
    } else throw new Error('Unknown measurement type')
  }
}

function calibrationInUnit(calibration: Calibration, unit: Unit): Calibration {
  return {
    pixelsPerUnit: calibration.pixelsPerUnit * micrometresPerUnit[unit] / micrometresPerUnit[calibration.unit],
    unit,
  }
}

export function measurementSetBoxes(images: MeasurementSetImage[], unit: Unit) {
  return images.flatMap((image) => {
    const calibration = calibrationInUnit(image.calibration, unit)
    return image.measurements.flatMap((measurement) => {
      if (measurement.kind !== 'box') return []
      const box = longAxisFirst(measurement.rect)
      return [{ length: box.width / calibration.pixelsPerUnit, width: box.height / calibration.pixelsPerUnit, q: box.width / box.height }]
    })
  })
}

const rawHeader = ['Name', 'Type', 'Length', 'Width', 'Q', 'Unit', 'Length_px', 'Width_px', 'Angle_deg']
const imageRecordHeader = [...rawHeader, 'Image', 'Image_width_px', 'Image_height_px', 'Pixels_per_unit', 'Center_x_px', 'Center_y_px', 'Start_x_px', 'Start_y_px', 'End_x_px', 'End_y_px']

function rawFields(item: Measurement, calibration: Calibration | null): string[] {
  const pixelsPerUnit = calibration?.pixelsPerUnit ?? 1
  const unit = calibration?.unit ?? 'px'
  if (item.kind === 'distance') {
    return [item.name, 'Distance', String(item.pixels / pixelsPerUnit), '', '', unit, String(item.pixels), '', '']
  }
  const { width, height, angle } = longAxisFirst(item.rect)
  const q = width / height
  return [item.name, 'Box', String(width / pixelsPerUnit), String(height / pixelsPerUnit), q.toFixed(4), unit, String(width), String(height), String(angle)]
}

// Prefix text that spreadsheets would evaluate as a formula.
function csvField(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) && !Number.isFinite(Number(value)) ? `'${value}` : value
  return `"${safe.replaceAll('"', '""')}"`
}

function unescapeText(value: string) {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value
}

function toCsv(rows: string[][]) {
  return rows.map((row) => row.map(csvField).join(',')).join('\n')
}

export function rawMeasurementsCsv(measurements: Measurement[], calibration: Calibration | null) {
  return toCsv([rawHeader, ...measurements.map((item) => rawFields(item, calibration))])
}

export function measurementSetCsv(images: MeasurementSetImage[], unit: Unit) {
  return toCsv([
    ['Image_ID', 'Image', ...rawHeader],
    ...images.flatMap((image) => image.measurements.map((measurement) => [
      image.id,
      image.imageName,
      ...rawFields(measurement, calibrationInUnit(image.calibration, unit)),
    ])),
  ])
}

export function imageRecordCsv(measurements: Measurement[], calibration: Calibration | null, imageName: string, imageSize: Point) {
  return toCsv([
    imageRecordHeader,
    ...measurements.map((item) => {
      const box = item.kind === 'box' ? normalizeOrientedBox(item.rect) : null
      const geometry = item.kind === 'box'
        ? [box!.centerX, box!.centerY, '', '', '', '']
        : ['', '', item.start.x, item.start.y, item.end.x, item.end.y]
      return [
        ...rawFields(item, calibration),
        imageName,
        String(imageSize.x),
        String(imageSize.y),
        calibration ? String(calibration.pixelsPerUnit) : '',
        ...geometry.map(String),
      ]
    }),
  ])
}

function parseCsv(text: string): string[][] {
  if (text.length > MAX_IMAGE_RECORD_CSV_BYTES) throw new Error('Image record CSV exceeds the 10 MiB limit')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char !== '"') field += char
      else if (text[index + 1] === '"') {
        field += '"'
        index++
      } else quoted = false
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++
      row.push(field)
      rows.push(row)
      if (rows.length > MAX_IMAGE_RECORD_MEASUREMENTS + 1) throw new Error('Image record CSV exceeds the 10,000 measurement limit')
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  if (rows.length > MAX_IMAGE_RECORD_MEASUREMENTS + 1) throw new Error('Image record CSV exceeds the 10,000 measurement limit')
  return rows
}

export function parseImageRecordCsv(text: string): ImageMeasurementData {
  const rows = parseCsv(text.replace(/^\uFEFF/, '')).filter((row) => row.some((field) => field.trim() !== ''))
  const [header, ...records] = rows
  if (!header) throw new Error('That CSV is empty')
  const columns = new Map(header.map((name, index) => [name.trim(), index]))
  if (imageRecordHeader.some((name) => !columns.has(name))) {
    throw new Error('That CSV has no saved image geometry · import an image record export')
  }
  if (!records.length) throw new Error('That CSV contains no measurements')

  const reader = (record: string[], rowNumber: number) => {
    const text = (name: string) => (record[columns.get(name)!] ?? '').trim()
    const number = (name: string) => {
      const value = Number(text(name))
      if (text(name) === '' || !Number.isFinite(value)) throw new Error(`Invalid ${name} in CSV row ${rowNumber}`)
      return value
    }
    return { text, number }
  }

  const first = reader(records[0], 2)
  const imageWidth = first.number('Image_width_px')
  const imageHeight = first.number('Image_height_px')
  if (!Number.isInteger(imageWidth) || !Number.isInteger(imageHeight) || imageWidth <= 0 || imageHeight <= 0 || imageWidth * imageHeight > MAX_IMAGE_RECORD_IMAGE_PIXELS) {
    throw new Error('Image dimensions are invalid or exceed 40 megapixels')
  }
  const unit = first.text('Unit')
  let calibration: Calibration | null = null
  if (unit !== 'px') {
    if (!(units as readonly string[]).includes(unit)) throw new Error(`Unsupported unit "${unit}" in CSV`)
    const pixelsPerUnit = first.number('Pixels_per_unit')
    if (pixelsPerUnit <= 0) throw new Error('Invalid calibration in CSV')
    calibration = { pixelsPerUnit, unit: unit as Unit }
  }

  const baseId = Date.now()
  const measurements = records.map((record, index): Measurement => {
    const { text, number } = reader(record, index + 2)
    const name = unescapeText(text('Name')) || `M${index + 1}`
    const id = baseId + index
    if (text('Type') === 'Distance') {
      const start = { x: number('Start_x_px'), y: number('Start_y_px') }
      const end = { x: number('End_x_px'), y: number('End_y_px') }
      return { id, kind: 'distance', start, end, pixels: Math.hypot(end.x - start.x, end.y - start.y), name }
    }
    if (text('Type') !== 'Box') throw new Error(`Unknown measurement type in CSV row ${index + 2}`)
    const width = number('Length_px')
    const height = number('Width_px')
    if (width <= 0 || height <= 0) throw new Error(`Invalid box size in CSV row ${index + 2}`)
    return {
      id,
      kind: 'box',
      objectId: `imported-${index + 1}`,
      rect: { centerX: number('Center_x_px'), centerY: number('Center_y_px'), width, height, angle: number('Angle_deg') },
      name,
    }
  })

  const imageData = { imageName: unescapeText(first.text('Image')), imageWidth, imageHeight, calibration, measurements }
  validateImageMeasurementData(imageData)
  return imageData
}
